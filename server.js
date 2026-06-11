const express = require('express');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

app.use(express.json());

// ป้ายต้อนรับหน้าแรก (ที่กดแล้วขึ้นไฟลุกเมื่อกี้)
app.get('/', (req, res) => {
  res.send('🔥 Backend is Running! ระบบรักษาความปลอดภัยเปิดใช้งานแล้ว!');
});

// ==========================================
// 🚀 ช่องทางรับข้อมูล Webhook (รองรับ Omnichannel & 15 OA)
// ==========================================
app.post('/webhook', async (req, res) => {
  // 1. ตรวจสอบรหัสความปลอดภัยลับของคุณพี่ก่อน
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
      provider_id,  // ID ของ LINE OA ตัวที่รับเรื่อง (เผื่อสำหรับ 15 OA)
      channel_name  // ชื่อบอทแต่ละตัว เอาไว้โชว์ใน UI
    } = req.body;

    // ตั้งค่า Default เผื่อ n8n ยังไม่ได้ส่งค่าเพื่อป้องกันโค้ดพัง
    const finalProviderId = provider_id || "DEFAULT_LINE_OA_01";
    const finalChannelName = channel_name || "LINE OA หลัก";
    
    // แปลงประเภทผู้ส่งให้ตรงกับ Enum ในฐานข้อมูล
    let finalSenderType = "CUSTOMER";
    if (sender_type?.toLowerCase() === 'bot') finalSenderType = "BOT";
    if (sender_type?.toLowerCase() === 'admin') finalSenderType = "ADMIN";

    // 2. มหาเทพสเต็ป: คุยกับฐานข้อมูล 4 ตารางรวดเดียวแบบไร้รอยต่อ
    
    // ตารางที่ 1: ตรวจสอบ/สร้าง ช่องทางติดต่อ (15 OA)
    const channel = await prisma.channel.upsert({
      where: { providerId: finalProviderId },
      update: { name: finalChannelName },
      create: {
        name: finalChannelName,
        platform: "LINE",
        providerId: finalProviderId
      }
    });

    // ตารางที่ 2: ตรวจสอบ/สร้าง โปรไฟล์ลูกค้า
    const customer = await prisma.customer.upsert({
      where: { platformUserId: line_user_id },
      update: { displayName: display_name },
      create: {
        platformUserId: line_user_id,
        displayName: display_name
      }
    });

    // ตารางที่ 3: ตรวจสอบ/สร้าง ห้องสนทนา (และดึงสถานะ สวิตช์ เปิด-ปิด บอท)
    const conversation = await prisma.conversation.upsert({
      where: {
        channelId_customerId: {
          channelId: channel.id,
          customerId: customer.id
        }
      },
      update: {}, // ถ้ามีห้องแชทอยู่แล้ว ไม่ต้องแก้อะไร ดึงข้อมูลมาเฉยๆ
      create: {
        channelId: channel.id,
        customerId: customer.id,
        botEnabled: true // เริ่มต้นให้เปิดบอทไว้เสมอ
      }
    });

    // 🧠 [ฟีเจอร์ที่ 5]: เช็คสวิตช์ เปิด-ปิดบอท ก่อนทำงาน
    // ถ้าบอทถูกปิดอยู่ และคนส่งไม่ใช่ลูกค้า (เป็นแอดมินคุยสด) เราจะบันทึกประวัติอย่างเดียว
    if (!conversation.botEnabled && finalSenderType === "BOT") {
      return res.json({ status: "ignored", message: "บอทถูกปิดใช้งานสำหรับลูกค้าคนนี้" });
    }

    // ตารางที่ 4: บันทึกประวัติแชททุกคำพูดลง Database 100%
    const newMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: finalSenderType,
        textContent: text_content,
        isInternal: false // ค่าเริ่มต้นไม่ใช่โน้ตเหลือง
      }
    });

    // 3. ตอบกลับ n8n ว่าบันทึกสำเร็จเรียบร้อย พร้อมส่งสถานะบอทกลับไปด้วย
    res.status(200).json({
      status: "Saved successfully",
      message_id: newMessage.id,
      bot_enabled: conversation.botEnabled, // ส่งไปบอก n8n ว่าบอทห้องนี้เปิดอยู่ไหม
      conversation_status: conversation.status
    });

  } catch (error) {
    console.error("❌ Webhook Error:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});