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
// 🚪 ประตูที่ 1: ศูนย์รวมรับส่งข้อมูลกลาง (The Ultimate Webhook Router)
// รองรับ: LINE Webhook ดิบลอย, n8n Sync Bot, และแอดมิน React พิมพ์คุยสด
// ====================================================================
app.post('/webhook', async (req, res) => {
  try {
    let userId, displayName, textContent, senderType;
    let needsActionInput = req.body.needsAction === true; // รับติ่งคำสั่งตรวจสอบเคสสำคัญ (เช่น ลืมรหัสผ่าน)

    // 🔎 ฝั่งที่ A: ตรวจสอบว่าข้อมูลยิงมาจากหน้าจอ React หรือ n8n (ส่งโครงสร้างแบบแบนมา)
    if (req.body.sender_type) {
      userId = req.body.line_user_id;
      displayName = req.body.display_name;
      textContent = req.body.text_content;
      senderType = req.body.sender_type;
    } 
    // 🔎 ฝั่งที่ B: ข้อมูลยิงตรงมาจาก LINE Official Account Webhook (โครงสร้างแบบลึก)
    else if (req.body.events && req.body.events.length > 0) {
      const event = req.body.events[0];
      
      // ดักจับเฉพาะประเภทข้อความที่เป็น Text เท่านั้น
      if (event.type === 'message' && event.message.type === 'text') {
        userId = event.source.userId;
        textContent = event.message.text;
        senderType = 'CUSTOMER';
        displayName = "ลูกค้า LINE"; // บันทึกชื่อชั่วคราว เดี๋ยวโหนด getUserLine ใน n8n จะมาอัปเดตชื่อจริงให้เอง
      } else {
        // หากลูกค้าส่งสติกเกอร์ หรือรูปภาพมา ให้ตอบรับ 200 เพื่อปิดลูปไว้ก่อน ระบบจะได้ไม่ค้าง
        return res.json({ success: true, message: "Non-text event ignored" });
      }
    }

    // ป้องกันกรณีระบบยิงมาแบบข้อมูลว่างเปล่า
    if (!userId || !textContent) {
      return res.status(400).send("Missing required parameters: userId or textContent");
    }

    // 🛠️ STEP 1: บันทึก/อัปเดตข้อมูลประวัติลูกค้าลงตาราง Customer
    const customer = await prisma.customer.upsert({
      where: { platformUserId: userId },
      update: displayName && displayName !== "ลูกค้า LINE" ? { displayName } : {},
      create: { platformUserId: userId, displayName: displayName || "ลูกค้า LINE" }
    });

    // 🛠️ STEP 2: คำนวณสถานะอัจฉริยะ (จุดเขียว/ป้ายส้ม) ประเมินตามบทบาทผู้ส่ง
    const conversationId = `conv_${customer.platformUserId}`; // กำหนด ID ห้องแชทแบบผูกติด ID LINE เพื่อไม่ให้แชทหลุดสาย
    let conversationUpdate = { updatedAt: new Date() };

    if (senderType === 'CUSTOMER') {
      conversationUpdate.isUnread = true;      // 🟢 ลูกค้าทักมา -> เปิดไฟจุดเขียวทันที
    } else if (senderType === 'ADMIN') {
      conversationUpdate.isUnread = false;     // ⚪ แอดมินตอบสด -> ดับไฟจุดเขียว
      conversationUpdate.needsAction = false;  // 🟠 แอดมินจัดการตอบเคสแล้ว -> เคลียร์ป้ายเตือน "ต้องจัดการ" ทิ้งทันที
    } else if (senderType === 'BOT') {
      conversationUpdate.isUnread = false;     // ⚪ บอทตอบให้แล้ว -> ดับไฟจุดเขียวตามกฎระบบ
      if (needsActionInput) {
        conversationUpdate.needsAction = true; // 🟠 หากบอทตรวจพบเจตนาสำคัญ (เช่น ลืมรหัส) -> ติดป้ายส้มต้องจัดการ!
      }
    }

    // 🛠️ STEP 3: บันทึก/อัปเดตสถานะห้องสนทนาลงตาราง Conversation
    const conversation = await prisma.conversation.upsert({
      where: { id: conversationId },
      create: {
        id: conversationId,
        customerId: customer.id,
        botEnabled: true,
        isUnread: senderType === 'CUSTOMER',
        needsAction: needsActionInput
      },
      update: conversationUpdate
    });

    // 🛠️ STEP 4: ยัดข้อความทุกเม็ดลงตาราง Message เพื่อเก็บเป็น Logs ประวัติแชทกลางจอ
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: senderType,
        textContent: textContent
      }
    });

    // 🚀 STEP 5: [ไม้ตายคุยสด] ถ้าแอดมินพิมพ์ตอบเอง ให้หลังบ้านยิงข้ามมิติเข้าแอป LINE บนมือถือลูกค้าทันที
    if (senderType === 'ADMIN') {
      try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
          to: userId,
          messages: [{ type: 'text', text: textContent }]
        }, {
          headers: {
            'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
      } catch (lineError) {
        console.error("❌ LINE Push API Error Details:", lineError.response?.data || lineError.message);
        return res.status(500).json({ 
          success: false, 
          error: "LINE Push Failed", 
          details: lineError.response?.data 
        });
      }
    }

    // ส่งสัญญาณตอบกลับว่าระบบบันทึกและรันข้อมูลผ่านฉลุย
    res.json({ success: true, message });

  } catch (error) {
    console.error("❌ Global Webhook Router Error:", error);
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
// 🚀 ปลุกเซิร์ฟเวอร์หลังบ้านขึ้นมาสแตนด์บายรับงานที่พอร์ต 3000
// ====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 [CRM Server ร่างทองครบสูบ] Engine is running smoothly on port ${PORT}`);
  console.log(`👉 Webhook Path Ready at: http://localhost:${PORT}/webhook \n`);
});