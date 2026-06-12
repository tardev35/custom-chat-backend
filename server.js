require('dotenv').config();
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors'); // เพิ่มตัวนี้เพื่อให้ React คุยกับ Backend ได้

const app = express();
const prisma = new PrismaClient();

app.use(cors()); // อนุญาตให้ React เข้าถึง API ได้
app.use(express.json());

// ----------------------------------------------------
// 1. ประตูสำหรับ n8n (อันเดิมที่เราทำไว้)
// ----------------------------------------------------
app.post('/webhook', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_SECRET_KEY) return res.status(401).send('Unauthorized');
  
  try {
    const { line_user_id, display_name, sender_type, text_content, provider_id, channel_name } = req.body;
    if (!line_user_id) return res.status(400).send('Missing ID');

    const channel = await prisma.channel.upsert({
      where: { providerId: provider_id || "DEFAULT" },
      update: { name: channel_name || "LINE OA" },
      create: { name: channel_name || "LINE OA", platform: "LINE", providerId: provider_id || "DEFAULT" }
    });

    const customer = await prisma.customer.upsert({
      where: { platformUserId: line_user_id },
      update: { displayName: display_name },
      create: { platformUserId: line_user_id, displayName: display_name }
    });

    const conversation = await prisma.conversation.upsert({
      where: { channelId_customerId: { channelId: channel.id, customerId: customer.id } },
      update: {}, 
      create: { channelId: channel.id, customerId: customer.id, botEnabled: true }
    });

    const newMessage = await prisma.message.create({
      data: { conversationId: conversation.id, senderType: sender_type?.toUpperCase() || "CUSTOMER", textContent: text_content }
    });

    res.json({ bot_enabled: conversation.botEnabled, status: "Saved" });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ----------------------------------------------------
// 2. [เพิ่มใหม่] ประตูดึงรายชื่อห้องแชท (ไปโชว์แถบซ้าย)
// ----------------------------------------------------
app.get('/conversations', async (req, res) => {
  const list = await prisma.conversation.findMany({
    include: { 
      customer: true,
      messages: { orderBy: { createdAt: 'desc' }, take: 1 } // ดึงข้อความล่าสุด 1 ข้อความ
    },
    orderBy: { updatedAt: 'desc' }
  });
  res.json(list);
});

// ----------------------------------------------------
// 3. [เพิ่มใหม่] ประตูดึงประวัติแชท (ไปโชว์ตรงกลาง)
// ----------------------------------------------------
app.get('/messages/:convId', async (req, res) => {
  const messages = await prisma.message.findMany({
    where: { conversationId: parseInt(req.params.convId) },
    orderBy: { createdAt: 'asc' }
  });
  res.json(messages);
});

// ----------------------------------------------------
// 4. [เพิ่มใหม่] ประตูสลับสวิตช์ เปิด-ปิดบอท (Toggle Bot)
// ----------------------------------------------------
app.put('/conversations/:id/toggle-bot', async (req, res) => {
  const { botEnabled } = req.body;
  const updated = await prisma.conversation.update({
    where: { id: parseInt(req.params.id) },
    data: { botEnabled: botEnabled }
  });
  res.json(updated);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API Ready on port ${PORT}`));