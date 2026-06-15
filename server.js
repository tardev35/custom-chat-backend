const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// ❌ ลบ const LINE_CHANNEL_ACCESS_TOKEN แบบเก่าทิ้งถาวร! 
// หลังบ้านจะยึดระบบดึงจากฐานข้อมูล Postgres ตามไอดีแบรนด์อัตโนมัติ

// ====================================================================
// 🔑 ⚙️ [เพิ่มใหม่สำหรับ 15 OA] ระบบบริหารจัดการช่องทาง (Channel Management)
// ====================================================================

// 1. ประตูบันทึก LINE OA หรือ Facebook Page บัญชีใหม่เข้าฐานข้อมูล
app.post('/channels', async (req, res) => {
  try {
    const { name, platform, providerId, accessToken } = req.body;
    if (!name || !platform || !providerId) return res.status(400).send("ข้อมูลไม่ครบถ้วน");

    const channel = await prisma.channel.upsert({
      where: { providerId: providerId },
      update: { name, accessToken },
      create: { name, platform, providerId, accessToken }
    });
    res.json({ success: true, channel });
  } catch (error) {
    console.error("❌ Add Channel Error:", error);
    res.status(500).send(error.message);
  }
});

// 2. ประตูดึงรายชื่อช่องทางทั้งหมดโชว์บนหน้าจอตั้งค่า และ Dropdown บนหน้าแชท
app.get('/channels', async (req, res) => {
  try {
    const channels = await prisma.channel.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json(channels);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🔑 ประตูระบบล็อกอินแอดมินเดิม (คงสภาพปกติ)
// ====================================================================
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await prisma.admin.findUnique({ where: { username } });
    if (!admin || admin.password !== password) {
      return res.status(401).json({ success: false, message: "Username หรือ รหัสผ่านไม่ถูกต้อง" });
    }
    res.json({ success: true, admin: { id: admin.id, name: admin.name, username: admin.username } });
  } catch (error) { res.status(500).send(error.message); }
});

// ====================================================================
// 🚪 ประตูที่ 1: ศูนย์รวมรับส่งข้อมูลกลาง (The Dynamic Webhook Router)
// ====================================================================
app.post('/webhook', async (req, res) => {
  try {
    let userId, displayName, textContent, senderType, adminId, incomingProviderId;
    let needsActionInput = req.body.needsAction === true;

    // 🔎 ฝั่งที่ A: ข้อมูลยิงมาจากหน้าจอ React ของแอดมิน (จังหวะแอดมินพิมพ์ส่งคุยสด)
    if (req.body.sender_type) {
      userId = req.body.line_user_id;
      displayName = req.body.display_name;
      textContent = req.body.text_content;
      senderType = req.body.sender_type.toUpperCase();
      adminId = req.body.admin_id;
    } 
    // 🔎 ฝั่งที่ B: ข้อมูลวิ่งมาจากระบบ LINE Webhook จริงของลูกค้า (ทักมาจาก 1 ใน 15 OA)
    else if (req.body.events && req.body.events.length > 0) {
      const event = req.body.events[0];
      if (event.type === 'message' && event.message.type === 'text') {
        userId = event.source.userId;
        textContent = event.message.text;
        senderType = 'CUSTOMER';
        displayName = "ลูกค้า LINE";
        
        // 🎯 ดักจับไอดีของ OA ต้นทางที่ไลน์ส่งพ่วงมาให้ เพื่อระบุตัวตนแบรนด์
        // หมายเหตุ: n8n สามารถส่งค่านี้มาทาง URL query หรือ JSON structure ได้เลยครับ
        incomingProviderId = req.query.provider_id || req.body.provider_id;
      } else {
        return res.json({ success: true, message: "Non-text event ignored" });
      }
    }

    if (!userId || !textContent) return res.status(400).send("Missing parameters");

    // 🛠️ STEP 1: เซฟลูกค้าลงดีบีตามสูตรปกติ
    const customer = await prisma.customer.upsert({
      where: { platformUserId: userId },
      update: displayName && displayName !== "ลูกค้า LINE" ? { displayName } : {},
      create: { platformUserId: userId, displayName: displayName || "ลูกค้า LINE" }
    });

    // 🛠️ STEP 2: ค้นหาช่องทางแบรนด์ (Channel Mapping) ในระบบ
    let targetedChannel = null;
    if (incomingProviderId) {
      targetedChannel = await prisma.channel.findUnique({ where: { providerId: incomingProviderId } });
    }

    // 🛠️ STEP 3: ตรวจสอบและซิงค์ห้องแชท (Dynamic Routing)
    let conversationUpdate = { updatedAt: new Date() };
    
    if (senderType === 'CUSTOMER') {
      conversationUpdate.isUnread = true;
      conversationUpdate.status = 'ACTIVE';
      if (targetedChannel) conversationUpdate.channelId = targetedChannel.id; // ผูกห้องเข้ากับ OA ต้นทาง
    } else {
      conversationUpdate.isUnread = false;
      conversationUpdate.needsAction = needsActionInput;
      if (senderType === 'ADMIN' && adminId) {
        conversationUpdate.assigneeId = adminId; // ออโต้มอบหมายงานให้คนพิมพ์ตอบ
      }
    }

    let conversation = await prisma.conversation.findFirst({ where: { customerId: customer.id } });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { 
          customerId: customer.id, 
          botEnabled: true, 
          isUnread: senderType === 'CUSTOMER', 
          needsAction: needsActionInput,
          status: 'ACTIVE',
          channelId: targetedChannel ? targetedChannel.id : null
        }
      });
    } else {
      // ดักเคสพิเศษ: เผื่อห้องเก่าไม่มีแชนแนลผูกไว้ ให้เติมแชนแนลเข้าไปด้วย
      if (targetedChannel && !conversation.channelId) {
        conversationUpdate.channelId = targetedChannel.id;
      }
      conversation = await prisma.conversation.update({ 
        where: { id: conversation.id }, 
        data: conversationUpdate 
      });
    }

    // ⏱️ [Analytics] คำนวณความไวในการตอบกลับของแอดมิน
    let calculatedResponseTime = null;
    if (senderType === 'ADMIN') {
      const lastCustomerMessage = await prisma.message.findFirst({
        where: { conversationId: conversation.id, senderType: 'CUSTOMER' },
        orderBy: { createdAt: 'desc' }
      });
      if (lastCustomerMessage) {
        const diffMs = new Date() - new Date(lastCustomerMessage.createdAt);
        calculatedResponseTime = Math.floor(diffMs / 1000);
      }
    }

    // 🛠️ STEP 4: บันทึกข้อมูลข้อความลงในตาราง Message
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: senderType,
        textContent: textContent,
        adminId: senderType === 'ADMIN' ? adminId : null,
        responseTime: calculatedResponseTime,
        isInternal: senderType === 'INTERNAL_NOTE'
      }
    });

    // 🛠️ STEP 5: [ทีเด็ดพระกาฬ 15 OA] ดึง Token ไดนามิก ยิงกระจายข้อความคืนหาลูกค้าจริงตามแบรนด์
    if (senderType === 'ADMIN') {
      // ดึงความสัมพันธ์ห้องแชทออกมาเบิกตัว Token ล่าสุด
      const currentConv = await prisma.conversation.findUnique({
        where: { id: conversation.id },
        include: { channel: true }
      });

      const dynamicToken = currentConv?.channel?.accessToken;

      if (!dynamicToken) {
        console.error(`❌ ไม่สามารถส่งไลน์ได้เนื่องจากห้องแชทนี้ยังไม่ได้ผูกสิทธิ์เข้าตาราง Channel หรือ Token ว่างเปล่า`);
        return res.status(400).send("ห้องแชทนี้ยังไม่ได้รับการตั้งค่าผูกสิทธิ์ LINE OA ในระบบ");
      }

      await axios.post('https://api.line.me/v2/bot/message/push', {
        to: userId,
        messages: [{ type: 'text', text: textContent }]
      }, {
        headers: { 
          'Authorization': `Bearer ${dynamicToken}`, // 🔥 สับสวิตช์ใช้ Token ไดนามิกสำเร็จ!
          'Content-Type': 'application/json' 
        }
      });
    }

    res.json({ success: true, message });
  } catch (error) {
    console.error("❌ Dynamic Webhook Error:", error);
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🚪 ประตูที่ 2: ดึงรายชื่อห้องแชททั้งหมด (รวมตัวแปรผูกมิตรช่องทาง)
// ====================================================================
app.get('/conversations', async (req, res) => {
  try {
    const conversations = await prisma.conversation.findMany({
      include: {
        customer: true,
        channel: true,  // ดึงชื่อแบรนด์ไปโชว์ป้ายกำกับหน้า UI ซ้ายมือ
        assignee: true, // ดึงคนรับผิดชอบเคส
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: { updatedAt: 'desc' }
    });
    res.json(conversations);
  } catch (error) { res.status(500).send(error.message); }
});

// ====================================================================
// 🚪 ประตูที่ 3: ดึงประวัติแชทฉบับเต็มคัดเรียงตามเวลา
// ====================================================================
app.get('/messages/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { isUnread: false }
    });
    const chatHistory = await prisma.message.findMany({
      where: { conversationId: conversationId },
      orderBy: { createdAt: 'asc' },
      include: { admin: true }
    });
    res.json(chatHistory);
  } catch (error) { res.status(500).send(error.message); }
});

// ====================================================================
// 🚪 ประตูที่ 4-8: ควบคุมสวิตช์ย่อย CRM (สลับบอท, ปิดเคส, ยึดเคส)
// ====================================================================
app.put('/conversations/:id/toggle-bot', async (req, res) => {
  try {
    const updated = await prisma.conversation.update({ where: { id: req.params.id }, data: { botEnabled: req.body.botEnabled } });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

app.put('/conversations/:id/toggle-action', async (req, res) => {
  try {
    const updated = await prisma.conversation.update({ where: { id: req.params.id }, data: { needsAction: req.body.needsAction } });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

app.put('/customers/:id/nickname', async (req, res) => {
  try {
    const updated = await prisma.customer.update({ where: { id: req.params.id }, data: { nickname: req.body.nickname } });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

app.put('/conversations/:id/status', async (req, res) => {
  try {
    const updated = await prisma.conversation.update({ where: { id: req.params.id }, data: { status: req.body.status } });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

app.put('/conversations/:id/assign', async (req, res) => {
  try {
    const updated = await prisma.conversation.update({ where: { id: req.params.id }, data: { assigneeId: req.body.adminId } });
    res.json(updated);