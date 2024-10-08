import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import multer from 'multer';
import fetch from 'node-fetch';
import FormData from 'form-data';
import mammoth from 'mammoth';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import dotenv from 'dotenv';


dotenv.config();

const app = express();
const PORT = 3000;

const corsOptions = {
  origin: '*', // 根據需要設置允許的域名
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: '1000mb' }));
app.use(bodyParser.urlencoded({ limit: '1000mb', extended: true }));


app.use(express.static(path.join(__dirname, '../frontend')));

// 配置路由以提供API key
app.get('/config', (req, res) => {
    res.json({ apiKeyGoogle: process.env.API_KEY_GOOGLE, openAIKey: process.env.OPENAI_KEY });
});



app.get('/', (req, res) => {
    res.send('語音轉文字後端服務運行中');
});

const storage = multer.memoryStorage();
const upload = multer({
    limits: { fileSize: 1000 * 1024 * 1024 }
});

ffmpeg.setFfmpegPath(ffmpegStatic);

async function splitAudio(filePath, segmentDuration = 240) {
    const tempDir = `./temp_${uuidv4()}`;
    fs.mkdirSync(tempDir);

    return new Promise((resolve, reject) => {
        ffmpeg(filePath)
            .output(`${tempDir}/output%03d.wav`)
            .outputOptions([`-f segment`, `-segment_time ${segmentDuration}`, `-c copy`])
            .on('end', () => resolve(tempDir))
            .on('error', reject)
            .run();
    });
}

async function transcribeAudio(filePath) {
    const stats = fs.statSync(filePath);
    const fileSizeInBytes = stats.size;
    const maxFileSize = 25 * 1024 * 1024;

    if (fileSizeInBytes > maxFileSize) {
        throw new Error('File size exceeds the 25MB limit.');
    }

    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath), 'audio.wav');
    formData.append('model', 'whisper-1');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.OPENAI_KEY}`
        },
        body: formData
    });

    const data = await response.json();
    if (response.ok) {
        return data.text;
    } else {
        throw new Error(data.error.message);
    }
}
app.post('/upload-audio', upload.single('file'), async (req, res) => {
    try {
        const uploadDir = './uploads';

        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        // 取得上傳檔案的原始副檔名
        const originalExtension = path.extname(req.file.originalname);
        const tempInputFilePath = `${uploadDir}/${uuidv4()}${originalExtension}`;
        const tempWavFilePath = `${uploadDir}/${uuidv4()}.wav`;

        // 將上傳的檔案儲存到臨時目錄
        fs.writeFileSync(tempInputFilePath, req.file.buffer);

        // 使用 ffmpeg 將檔案轉換為 WAV 格式
        await new Promise((resolve, reject) => {
            ffmpeg(tempInputFilePath)
                .toFormat('wav')
                .output(tempWavFilePath)
                .on('end', () => {
                    console.log('File has been converted successfully');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('An error occurred during file conversion:', err);
                    reject(err);
                })
                .run();
        });

        // 現在進行轉錄
        const text = await transcribeAudio(tempWavFilePath);

        // 清理臨時檔案
        fs.unlinkSync(tempInputFilePath);
        fs.unlinkSync(tempWavFilePath);

        res.json({ text });
    } catch (error) {
        console.error('Error processing audio upload:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/upload-doc', upload.single('file'), async (req, res) => {
    try {
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        let text = '';

        if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ buffer: file.buffer });
            text = result.value;
        } else if (file.mimetype === 'text/plain') {
            text = file.buffer.toString('utf-8');
        } else {
            return res.status(400).json({ error: 'Unsupported file type' });
        }

        res.json({ text });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/summarize-text', async (req, res) => {
    const { text, language } = req.body;
    const openAIKey = process.env.OPENAI_KEY;
    
    let systemMessage;
    switch (language) {
        case 'en':
            systemMessage = 'You are an assistant who helps to summarize the text.';
            break;
        case 'ja':
            systemMessage = 'あなたはテキストを要約するアシスタントです。';
            break;
        case 'zh-TW':
            systemMessage = '你是一個幫助生成摘要的助手，請確保輸出為繁體中文。';
            break;
        case 'id':
            systemMessage = 'Anda adalah asisten yang membantu meringkas teks.';
            break;
        case 'vi':
            systemMessage = 'Bạn là trợ lý giúp tóm tắt văn bản.';
        case 'th':
            systemMessage = 'คุณคือผู้ช่วยที่ช่วยสรุปข้อความ ';
            break;
        default:
            systemMessage = '你是一個幫助生成摘要的助手，請確保輸出為繁體中文，絕對不准出現簡體字。';
    }

    const userMessage = language === 'en'
        ? `Please summarize the following content:\n\n${text}`
        : language === 'ja'
        ? `次の内容を要約してください:\n\n${text}`
        : language === 'id'
        ? `Silakan ringkas konten berikut:\n\n${text}`
        : language === 'vi'
        ? `Vui lòng tóm tắt nội dung sau:\n\n${text}`
      : language === 'th'
        ? `กรุณาสรุปเนื้อหาต่อไปนี้: \n\n${text}`
        : `請總結以下內容:請確保輸出為繁體中文，絕對不准出現簡體字。\n\n${text}`;

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4-turbo',
                messages: [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content: userMessage }
                ],
                max_tokens: 2000,
                stop: null
            })
        });

        const data = await response.json();
        if (response.ok) {
            res.json({ summarizedText: data.choices[0].message.content.trim() });
        } else {
            res.status(500).json({ error: data.error.message });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/highlight-text', async (req, res) => {
    const { text, language } = req.body;

    let systemMessage;
    switch (language) {
        case 'en':
            systemMessage = 'You are an assistant who helps to extract key points from the text.';
            break;
        case 'ja':
            systemMessage = 'あなたはテキストから要点を抽出するアシスタントです。';
            break;
        case 'zh-TW':
            systemMessage = '你是一個幫助提取重點的助手，請確保輸出為繁體中文。';
            break;
        case 'id':
            systemMessage = 'Anda adalah asisten yang membantu mengekstrak poin utama dari teks.';
            break;
        case 'vi':
            systemMessage = 'Bạn là trợ lý giúp trích xuất các điểm chính từ văn bản.';
        case 'th':
            systemMessage = 'คุณเป็นผู้ช่วยที่ช่วยสกัดจุดสำคัญจากข้อความ ';
            break;
        default:
            systemMessage = '你是一個幫助提取重點的助手，請確保輸出為繁體中文，絕對不准出現簡體字。';
    }

    const userMessage = language === 'en'
        ? `Please extract three key points from the following content:\n\n${text}`
        : language === 'ja'
        ? `次の内容から三つの要点を抽出してください:\n\n${text}`
        : language === 'id'
        ? `Silakan ekstrak tiga poin utama dari konten berikut:\n\n${text}`
        : language === 'vi'
        ? `Vui lòng trích xuất ba điểm chính từ nội dung sau:\n\n${text}`
        : language === 'th'
        ? `กรุณาสกัดจุดสำคัญจากเนื้อหาต่อไปนี้: \n\n${text}`
        : `請從以下內容中提取三個重點:請確保輸出為繁體中文，絕對不准出現簡體字。\n\n${text}`;

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4-turbo',
                messages: [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content: userMessage }
                ],
                max_tokens: 2000,
                stop: null
            })
        });

        const data = await response.json();
        if (response.ok) {
            res.json({ highlightedText: data.choices[0].message.content.trim() });
        } else {
            res.status(500).json({ error: data.error.message });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/polish-text', async (req, res) => {
    const { text, language } = req.body;

    let systemMessage;
    switch (language) {
        case 'en':
            systemMessage = 'You are an assistant who helps to polish the text.';
            break;
        case 'ja':
            systemMessage = 'あなたはテキストを修飾するアシスタントです。';
            break;
        case 'zh-TW':
            systemMessage = '你是一個幫助修飾文本的助手，請確保輸出為繁體中文，並保留英文人名或詞彙。';
            break;
        case 'id':
            systemMessage = 'Anda adalah asisten yang membantu memperhalus teks.';
            break;
        case 'vi':
            systemMessage = 'Bạn là trợ lý giúp chỉnh sửa văn bản.';
        case 'th':
            systemMessage = 'คุณคือผู้ช่วยในการช่วยขัดเกลาข้อความ ';
            break;
        default:
            systemMessage = '你是一個幫助修飾文本的助手，請確保輸出為繁體中文，絕對不准出現簡體字。';
    }

    const userMessage = language === 'en'
        ? `Please polish the following content:\n\n${text}`
        : language === 'ja'
        ? `次の内容を修飾してください:\n\n${text}`
        : language === 'id'
        ? `Silakan perhalus konten berikut:\n\n${text}`
        : language === 'vi'
        ? `Vui lòng chỉnh sửa nội dung sau:\n\n${text}`
        : language === 'th'
        ? `กรุณาช่วยขัดเกลาข้อความต่อไปนี้: \n\n${text}`
        : `請修飾以下內容:並且跟原意思相近，並確保輸出為繁體中文，絕對不准出現簡體字\n\n${text}`;

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4-turbo',
                messages: [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content: userMessage }
                ],
                max_tokens: 2000,
                stop: null
            })
        });

        const data = await response.json();
        if (response.ok) {
            res.json({ polishedText: data.choices[0].message.content.trim() });
        } else {
            res.status(500).json({ error: data.error.message });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
