const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 🛡️ ฟังก์ชัน "ยาม" ตรวจสอบ API Key (Middleware)
const checkApiKey = (req, res, next) => {
    const userApiKey = req.headers['x-api-key']; // อ่านค่าจาก Header ชื่อ x-api-key
    const systemApiKey = process.env.API_SECRET_KEY; // รหัสลับที่เราตั้งไว้ใน .env

    if (!userApiKey || userApiKey !== systemApiKey) {
        console.log('🚨 มีคนพยายามบุกรุกเข้ามาโดยไม่มีบัตรผ่านที่ถูกต้อง!');
        return res.status(401).json({ error: 'Unauthorized: NO DATA' });
    }
    next(); // บัตรผ่านถูกต้อง อนุญาตให้ไปต่อได้
};

// 🚦 1. Route ต้อนรับ (เปิดให้ดูได้ปกติ)
app.get('/', (req, res) => {
    res.send('🔥 Backend is Running! ระบบรักษาความปลอดภัยเปิดใช้งานแล้ว!');
});

// 📩 2. ช่องทางรับ Webhook (ปล่อยให้เข้าได้ เพราะเราเช็คผ่านระบบอ้อมของ n8n/CF แล้ว)
app.post('/webhook', async (req, res) => {
    try {
        const { line_user_id, display_name, sender_type, text_content, state, type_issue } = req.body;
        const customer = await prisma.customer.upsert({
            where: { line_user_id: line_user_id },
            update: { display_name, state, type_issue },
            create: {
                line_user_id,
                display_name: display_name || 'LINE User',
                state: state || 'bot',
                type_issue: type_issue || null
            },
        });
        await prisma.message.create({
            data: { line_user_id, sender_type: sender_type || 'customer', text_content },
        });
        res.status(200).json({ success: true, message: 'Saved successfully' });
    } catch (error) {
        res.status(500).send('Database Error');
    }
});

// 🗂️ 3. API ดึงรายชื่อลูกค้าทั้งหมด (🔒 ล็อกแล้วด้วย checkApiKey)
app.get('/customers', checkApiKey, async (req, res) => {
    try {
        const customers = await prisma.customer.findMany({ orderBy: { last_updated: 'desc' } });
        res.status(200).json(customers);
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// 💬 4. API ดึงประวัติข้อความ (🔒 ล็อกแล้วด้วย checkApiKey)
app.get('/messages/:line_user_id', checkApiKey, async (req, res) => {
    try {
        const { line_user_id } = req.params;
        const messages = await prisma.message.findMany({
            where: { line_user_id },
            orderBy: { created_at: 'asc' }
        });
        res.status(200).json(messages);
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server is running on http://localhost:${PORT}`);
});