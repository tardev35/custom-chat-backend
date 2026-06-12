require('dotenv').config(); // เพิ่มตัวโหลดไฟล์ .env ให้ชัวร์ 100%
const express = require('express');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

app.use(express.json());

// ป้ายต้อนรับหน้าแรก
app.get('/', (req, res) => {
  res.send('🔥 Backend is Running! ระบบรักษาความปลอดภัยเปิดใช้งานแล้ว!');
});

// ==========================================
// 🚀 ช่องทางรับข้อมูล Webhook (รองรับ Omnichannel & 15 OA)
// ==========================================
app.post('/webhook', async (req, res) => {
  // 1. ตรวจสอบรหัสความปลอดภัย
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized: รหัสลับไม่ถูกต้อง' });
  }

  try {
    const { 
      line_user_id, 
      display_name, 
      sender_type, 
      text_content,
      provider_id,  
      channel_name  
    } = req.body;

    // 🚨 ดัก Error ป้องกันแครช: ถ้า n8n ลืมส่ง line_user_id มา ให้ตีกลับทันที
    if (!line_user_id) {
        return res.status(400).json({ error: 'Bad Request: Missing line_user_id' });
    }

    const finalProviderId = provider_id || "DEFAULT_LINE_OA_01";
    const finalChannelName = channel_name || "LINE OA หลัก";
    
    let finalSenderType = "CUSTOMER";
    if (sender_type?.toLowerCase() === 'bot') finalSenderType = "BOT";
    if (sender_type?.toLowerCase() === 'admin') finalSenderType = "ADMIN";

    // 2. มหาเทพสเต็ป: คุยกับฐานข้อมูล 4 ตาราง
    const channel = await prisma.channel.upsert({
      where: { providerId: finalProviderId },
      update: { name: finalChannelName },
      create: {
        name: finalChannelName,
        platform: "LINE",
        providerId: finalProviderId
      }
    });

    const customer = await prisma.customer.upsert({
      where: { platformUserId: line_user_id },
      update: { displayName: display_name },
      create: {
        platformUserId: line_user_id,
        displayName: display_name
      }
    });

    const conversation = await prisma.conversation.upsert({
      where: {
        channelId_customerId: {
          channelId: channel.id,
          customerId: customer.id
        }
      },
      update: {}, 
      create: {
        channelId: channel.id,
        customerId: customer.id,
        botEnabled: true 
      }
    });

    if (!conversation.botEnabled && finalSenderType === "BOT") {
      return res.json({ status: "ignored", message: "บอทถูกปิดใช้งานสำหรับลูกค้าคนนี้" });
    }

    const newMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: finalSenderType,
        textContent: text_content,
        isInternal: false 
      }
    });

    // 3. ตอบกลับ n8n
    res.status(200).json({
      status: "Saved successfully",
      message_id: newMessage.id,
      bot_enabled: conversation.botEnabled, 
      conversation_status: conversation.status
    });

  } catch (error) {
    console.error("❌ Webhook Error:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

// ==========================================
// 🚨 จุดที่ผมตกม้าตายรอบที่แล้ว! สั่งเปิดเซิร์ฟเวอร์ที่พอร์ต 3000
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
});