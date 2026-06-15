const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

// 🐘 เริ่มต้นใช้งานตัวคุมฐานข้อมูล Prisma 
const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// ⚠️ [สำคัญมาก] สลับเอา Channel Access Token จริงจาก LINE Developers มาใส่ตรงนี้ครับ
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "eeDp68WfJfHPbIam/pB0zQVU5j2km9rx+sKV1JhPZd6YR30UWdb7rvULFOMPIBwaUa16CDuMnQcXzdbINKXvwe5mhyvH1lytfRybmBj0PhUGYUZrrgHsWl/i5szFJrW2ZVlnHwBk6+0rOimx0voVzAdB04t89/1O/w1cDnyilFU=";

// ====================================================================
// 🔑 [เพิ่มใหม่] ประตูสมัครบัญชีแอดมิน (Admin Register)
// ====================================================================
app.post('/register', async (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username || !password || !name) return res.status(400).send("ข้อมูลไม่ครบ");

    const newAdmin = await prisma.admin.create({
      data: { username, password, name } // 💡 โน้ต: โปรดักชันจริงควรใช้ bcrypt ครอบรหัสผ่านนะครับ
    });
    res.json({ success: true, admin: { id: newAdmin.id, name: newAdmin.name } });
  } catch (error) {
    res.status(400).send("Username นี้ถูกใช้ไปแล้วครับ");
  }
});

// ====================================================================
// 🔑 [เพิ่มใหม่] ประตูตรวจสอบรหัสผ่านล็อกอิน (Admin Login)
// ====================================================================
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await prisma.admin.findUnique({ where: { username } });

    if (!admin || admin.password !== password) {
      return res.status(401).json({ success: false, message: "Username หรือ รหัสผ่านไม่ถูกต้อง" });
    }
    res.json({ success: true, admin: { id: admin.id, name: admin.name, username: admin.username } });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🚪 ประตูที่ 1: [ปรับปรุงใหม่] ศูนย์รวมรับส่งข้อมูลกลาง (Webhook Router)
// ====================================================================
app.post('/webhook', async (req, res) => {
  try {
    let userId, displayName, textContent, senderType, adminId;
    let needsActionInput = req.body.needsAction === true;

    if (req.body.sender_type) {
      userId = req.body.line_user_id;
      displayName = req.body.display_name;
      textContent = req.body.text_content;
      senderType = req.body.sender_type.toUpperCase();
      adminId = req.body.admin_id; // 🟢 รับไอดีแอดมินส่งมาจากหน้าจอ React
    } else if (req.body.events && req.body.events.length > 0) {
      const event = req.body.events[0];
      if (event.type === 'message' && event.message.type === 'text') {
        userId = event.source.userId;
        textContent = event.message.text;
        senderType = 'CUSTOMER';
        displayName = "ลูกค้า LINE";
      } else {
        return res.json({ success: true, message: "Non-text event ignored" });
      }
    }

    if (!userId || !textContent) return res.status(400).send("Missing parameters");

    const customer = await prisma.customer.upsert({
      where: { platformUserId: userId },
      update: displayName && displayName !== "ลูกค้า LINE" ? { displayName } : {},
      create: { platformUserId: userId, displayName: displayName || "ลูกค้า LINE" }
    });

    let conversationUpdate = { updatedAt: new Date() };
    if (senderType === 'CUSTOMER') {
      conversationUpdate.isUnread = true;
    } else {
      conversationUpdate.isUnread = false;
      conversationUpdate.needsAction = needsActionInput;
    }

    let conversation = await prisma.conversation.findFirst({ where: { customerId: customer.id } });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { customerId: customer.id, botEnabled: true, isUnread: senderType === 'CUSTOMER', needsAction: needsActionInput }
      });
    } else {
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: conversationUpdate });
    }

    // ⏱️ [ไม้ตายคำนวณเวลาร่างทอง] ถ้าเป็นแอดมินตอบ ให้หาเวลาชนกับข้อความลูกค้าล่าสุด
    let calculatedResponseTime = null;
    if (senderType === 'ADMIN') {
      const lastCustomerMessage = await prisma.message.findFirst({
        where: { conversationId: conversation.id, senderType: 'CUSTOMER' },
        orderBy: { createdAt: 'desc' }
      });
      if (lastCustomerMessage) {
        // หาผลต่างเวลา (หน่วยมิลลิวินาที) แปลงเป็นวินาที
        const diffMs = new Date() - new Date(lastCustomerMessage.createdAt);
        calculatedResponseTime = Math.floor(diffMs / 1000); 
      }
    }

    // ยัดข้อมูลลงตาราง Message พร้อมสถิติแอดมิน
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: senderType,
        textContent: textContent,
        adminId: senderType === 'ADMIN' ? adminId : null, // ฝังผลงานแอดมินคนส่ง
        responseTime: calculatedResponseTime            // ฝังเวลาความไวสปีดเก้า
      }
    });

    if (senderType === 'ADMIN') {
      await axios.post('https://api.line.me/v2/bot/message/push', {
        to: userId,
        messages: [{ type: 'text', text: textContent }]
      }, {
        headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
      });
    }

    res.json({ success: true, message });
  } catch (error) {
    console.error("❌ Webhook Error:", error);
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🚪 ประตูที่ 2: ดึงรายชื่อห้องแชทลูกค้าทั้งหมด (แถบซ้ายมือ)
// ออกแบบมาให้โหลดเร็ว ดึงเฉพาะโมเดลลูกค้า และข้อความล่าสุดประโยคเดียวมาพรีวิว
// ====================================================================
app.get('/conversations', async (req, res) => {
  try {
    const list = await prisma.conversation.findMany({
      orderBy: { updatedAt: 'desc' }, // ดันห้องแชทที่มีการเคลื่อนไหวล่าสุดขึ้นบนสุดเสมอ
      include: {
        customer: true, // แนบโปรไฟล์ ชื่อ/ชื่อเล่น/รูปภาพ
        messages: {
          orderBy: { createdAt: 'desc' }, // ดึงข้อความเพื่อมาทำพรีวิว
          take: 1 // หยิบแค่ประโยคเดียวล่าสุดเพื่อประหยัด RAM เซิร์ฟเวอร์
        }
      }
    });
    res.json(list);
  } catch (error) {
    console.error("❌ Get Conversations Error:", error);
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🚪 ประตูที่ 3: ดึงประวัติการคุยฉบับเต็มเรียงตามเวลา (กล่องแชทตรงกลางจอ)
// ====================================================================
app.get('/messages/:conversationId', async (req, res) => {
  try {
    const chatHistory = await prisma.message.findMany({
      where: { conversationId: req.params.conversationId },
      orderBy: { createdAt: 'asc' } // เรียงจากเก่าไปใหม่ตามไทม์ไลน์แชทปกติ
    });
    res.json(chatHistory);
  } catch (error) {
    console.error("❌ Get Messages Error:", error);
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🚪 ประตูที่ 4: ปุ่มสับสวิตช์ เปิด-ปิด บอทอัจฉริยะ (Toggle Bot Mode)
// ====================================================================
app.put('/conversations/:id/toggle-bot', async (req, res) => {
  try {
    const { botEnabled } = req.body;
    const updatedStatus = await prisma.conversation.update({
      where: { id: req.params.id },
      data: { botEnabled: botEnabled }
    });
    res.json(updatedStatus);
  } catch (error) {
    console.error("❌ Toggle Bot Status Error:", error);
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🚪 ประตูที่ 5: บันทึกและแก้ไขชื่อเล่น / Username ลูกค้า (CRM Nickname)
// ====================================================================
app.put('/customers/:id/nickname', async (req, res) => {
  try {
    const { nickname } = req.body;
    const updatedCustomer = await prisma.customer.update({
      where: { id: req.params.id },
      data: { nickname: nickname }
    });
    res.json(updatedCustomer);
  } catch (error) {
    console.error("❌ Save Customer Nickname Error:", error);
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🚪 ประตูที่ 6: [เพิ่มใหม่] ปุ่มแอดมินกดติดแท็ก/เคลียร์แท็ก "ต้องดำเนินการ" ด้วยมือตัวเอง
// ====================================================================
app.put('/conversations/:id/toggle-action', async (req, res) => {
  try {
    const { needsAction } = req.body;
    const updatedStatus = await prisma.conversation.update({
      where: { id: req.params.id },
      data: { needsAction: needsAction }
    });
    res.json(updatedStatus);
  } catch (error) {
    console.error("❌ Toggle Action Status Error:", error);
    res.status(500).send(error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 [CRM Server ร่างทองครบสูบ] Engine is running smoothly on port ${PORT}`);
  console.log(`👉 Webhook Path Ready at: http://localhost:${PORT}/webhook \n`);
});