const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// ====================================================================
// ⚙️ [ระบบ 15 OA] บริหารจัดการช่องทางร้านค้า (Channel Management - CRUD)
// ====================================================================

// 1. บันทึก/อัปเดต LINE OA บัญชีใหม่เข้าฐานข้อมูล (ผูก Token แบบไดนามิก)
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


// 2. ดึงรายชื่อช่องทาง LINE OA ทั้งหมดไปโชว์ในหน้าตั้งค่า และ Dropdown หน้าแชท
app.get('/channels', async (req, res) => {
  try {
    const channels = await prisma.channel.findMany(); // 🟢 ดึงมาตรงๆ เลย ไม่ต้องสั่งเรียงตามวันที่แล้วครับ
    res.json(channels);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// 3. [อัปเดตใหม่] แก้ไขข้อมูล LINE OA บัญชีเดิม (แก้ไขชื่อ / Token)
app.put('/channels/:id', async (req, res) => {
  try {
    const { name, providerId, accessToken } = req.body;
    const updated = await prisma.channel.update({
      where: { id: req.params.id },
      data: { name, providerId, accessToken }
    });
    res.json(updated);
  } catch (error) { 
    res.status(500).send(error.message); 
  }
});

// 4. [อัปเดตใหม่] ลบบัญชี LINE OA ออกจากระบบ
app.delete('/channels/:id', async (req, res) => {
  try {
    await prisma.channel.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) { 
    res.status(500).send(error.message); 
  }
});

// ====================================================================
// 🔑 [ระบบแอดมิน] ตรวจสอบสิทธิ์และล็อกอิน (Authentication)
// ====================================================================

// 5. ประตูสมัครสมาชิกแอดมิน (เอาไว้ใช้เบิกไอดีเพิ่มทีมงาน)
app.post('/register', async (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username || !password || !name) return res.status(400).send("ข้อมูลไม่ครบ");

    const newAdmin = await prisma.admin.create({
      data: { username, password, name }
    });
    res.json({ success: true, admin: { id: newAdmin.id, name: newAdmin.name } });
  } catch (error) {
    res.status(400).send("Username นี้ถูกใช้ไปแล้วครับ");
  }
});

// 6. ประตูตรวจสอบรหัสผ่านล็อกอินแอดมินดักหน้า UI
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
// 🚪 [ประตูหลัก] ศูนย์รวมรับส่งข้อมูลแชทกลาง (The Dynamic Webhook Router)
// ====================================================================
app.post('/webhook', async (req, res) => {
  try {
    let userId, displayName, textContent, senderType, adminId, incomingProviderId;
    let needsActionInput = req.body.needsAction === true;

    // 🔎 ฝั่งที่ A: ข้อมูลยิงมาจากหน้าจอ React ของแอดมิน หรือยิงมาจากบอท n8n
    if (req.body.sender_type) {
      userId = req.body.line_user_id;
      displayName = req.body.display_name;
      textContent = req.body.text_content;
      senderType = req.body.sender_type.toUpperCase(); // แอดมิน = ADMIN, บอท = BOT
      adminId = req.body.admin_id; 
      incomingProviderId = req.body.provider_id; // รับค่า Channel ID จาก n8n เพื่อเอาไปคัดกรองแยกสาขา
    } 
    // 🔎 ฝั่งที่ B: ข้อความวิ่งมาจาก LINE OA จริงของลูกค้า (ทักมาจาก 1 ใน 15 บัญชี)
    else if (req.body.events && req.body.events.length > 0) {
      const event = req.body.events[0];
      if (event.type === 'message' && event.message.type === 'text') {
        userId = event.source.userId;
        textContent = event.message.text;
        senderType = 'CUSTOMER';
        displayName = "ลูกค้า LINE";
        
        // ดักจับไอดีของ OA ต้นทางที่ไลน์ส่งพ่วงมาให้
        incomingProviderId = req.query.provider_id || req.body.provider_id;
      } else {
        return res.json({ success: true, message: "Non-text event ignored" });
      }
    }

    if (!userId || !textContent) return res.status(400).send("Missing parameters");

    // 🛠️ STEP 1: บันทึกข้อมูลลูกค้าลงฐานข้อมูล
    const customer = await prisma.customer.upsert({
      where: { platformUserId: userId },
      update: displayName && displayName !== "ลูกค้า LINE" ? { displayName } : {},
      create: { platformUserId: userId, displayName: displayName || "ลูกค้า LINE" }
    });

    // 🛠️ STEP 2: ค้นหาช่องทางแบรนด์คู่ค้า (Channel Mapping)
    let targetedChannel = null;
    if (incomingProviderId) {
      targetedChannel = await prisma.channel.findUnique({ where: { providerId: incomingProviderId } });
    }

    // 🛠️ STEP 3: ตรวจสอบห้องแชทและอัปเดตสถานะ (Auto-Assign & แท็บสไตล์ Pedpro)
    let conversationUpdate = { updatedAt: new Date() };
    
    if (senderType === 'CUSTOMER') {
      conversationUpdate.isUnread = true;
      conversationUpdate.status = 'ACTIVE'; 
      if (targetedChannel) conversationUpdate.channelId = targetedChannel.id; 
    } else {
      conversationUpdate.isUnread = false;
      conversationUpdate.needsAction = needsActionInput;
      
      // 🟢 มหาเวทย์ออโต้มอบหมายงาน: แอดมินมนุษย์พิมพ์ตอบ ล็อกสิทธิ์เป็นแชท "ของฉัน" ทันที + สั่งปิดบอท n8n ออโต้!
      if (senderType === 'ADMIN' && adminId) {
        conversationUpdate.assigneeId = adminId;
        conversationUpdate.botEnabled = false; // แอดมินคุยมือแล้ว บอทต้องหยุดตอบทันที
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
      if (targetedChannel && !conversation.channelId) {
        conversationUpdate.channelId = targetedChannel.id;
      }
      conversation = await prisma.conversation.update({ 
        where: { id: conversation.id }, 
        data: conversationUpdate 
      });
    }

    // ⏱️ [สถิติความเร็ว] คำนวณเวลาที่ใช้ตอบกลับ (Response Time) ของแอดมิน
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

    // 🛠️ STEP 4: บันทึกประวัติข้อความลงตาราง Message ทุกเม็ด 100% (จำแนกประเภทสีแชทผ่าน senderType)
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: senderType, // CUSTOMER, ADMIN, BOT, INTERNAL_NOTE
        textContent: textContent,
        adminId: senderType === 'ADMIN' ? adminId : null,
        responseTime: calculatedResponseTime,
        isInternal: senderType === 'INTERNAL_NOTE' 
      }
    });

    // 🛠️ STEP 5: สลับ Token ไดนามิก ยิงกระจายข้อความแอดมินคืนสู่แอป LINE ลูกค้าจริง
    if (senderType === 'ADMIN') {
      const currentConv = await prisma.conversation.findUnique({
        where: { id: conversation.id },
        include: { channel: true }
      });

      const dynamicToken = currentConv?.channel?.accessToken;

      if (!dynamicToken) {
        return res.status(400).send("ห้องแชทนี้ยังไม่ได้รับการตั้งค่าผูกสิทธิ์ LINE OA ในระบบตั้งค่าระบบ");
      }

      await axios.post('https://api.line.me/v2/bot/message/push', {
        to: userId,
        messages: [{ type: 'text', text: textContent }]
      }, {
        headers: { 
          'Authorization': `Bearer ${dynamicToken}`, 
          'Content-Type': 'application/json' 
        }
      }).catch(err => console.error("❌ Line Push Notification Error"));
    }

    // ส่งสถานะสวิตช์บอทล่าสุดกลับไปให้ n8n นำไปเข้าเงื่อนไข IF Node
    res.json({ 
      success: true, 
      message: message,
      bot_enabled: conversation.botEnabled 
    });
  } catch (error) {
    console.error("❌ Webhook Error:", error);
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🚪 [ประตูข้อมูล UI] ดึงข้อมูลรายชื่อแชทและประวัติการคุย
// ====================================================================

// 7. ดึงรายชื่อห้องแชททั้งหมด
app.get('/conversations', async (req, res) => {
  try {
    const conversations = await prisma.conversation.findMany({
      include: {
        customer: true,
        channel: true,  
        assignee: true, 
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
      // 🟢 นำ orderBy: { updatedAt: 'desc' } ตรงนี้ออกไปเลยครับ
    });

   // 🟢 [แก้ไขลอจิก] สั่งเรียงลำดับตามเวลาของข้อความล่าสุดสดๆ ก่อนส่งออกไป
    conversations.sort((a, b) => {
      // ใช้ .getTime() เพื่อให้เปรียบเทียบตัวเลขมิลลิวินาทีได้แม่นยำขึ้น
      const timeA = a.messages[0] ? new Date(a.messages[0].createdAt).getTime() : new Date(a.createdAt).getTime();
      const timeB = b.messages[0] ? new Date(b.messages[0].createdAt).getTime() : new Date(b.createdAt).getTime();
      
      // ล็อกเป้าความเสถียร: ถ้าเวลาเท่ากันเป๊ะ ให้เรียงตามตัวอักษรของ ID แทน ป้องกันการสลับที่มั่วซั่ว
      if (timeB === timeA) {
        return a.id.localeCompare(b.id);
      }
      return timeB - timeA; // ข้อความใหม่สุดอยู่บนสุด
    });

    res.json(conversations);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// 8. ดึงประวัติแชทห้องปัจจุบันฉบับเต็มเรียงตามเวลา
app.get('/messages/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;

    // 🟢 [แก้ไขตรงนี้] เช็คก่อนว่าห้องแชทนี้เป็น Unread หรือไม่ ถ้าใช่ถึงค่อยล้างจุดเขียว เวลาจะได้ไม่ขยับมั่วซั่ว
    const currentConv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (currentConv && currentConv.isUnread) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { isUnread: false }
      });
    }

    const chatHistory = await prisma.message.findMany({
      where: { conversationId: conversationId },
      orderBy: { createdAt: 'asc' },
      include: { admin: true }
    });
    res.json(chatHistory);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🎛️ [ประตูควบคุมสวิตช์ CRM] เปลี่ยนค่ารายบุคคลตามปุ่มหน้า UI React
// ====================================================================

// 9. สลับสถานะเปิด-ปิด บอทตอบแทนรายบุคคล
app.put('/conversations/:id/toggle-bot', async (req, res) => {
  try {
    const updated = await prisma.conversation.update({ where: { id: req.params.id }, data: { botEnabled: req.body.botEnabled } });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

// 10. สลับป้ายส้มเตือน "ต้องดำเนินการ" (เช่น ลูกค้าลืมรหัสผ่าน)
app.put('/conversations/:id/toggle-action', async (req, res) => {
  try {
    const updated = await prisma.conversation.update({ where: { id: req.params.id }, data: { needsAction: req.body.needsAction } });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

// 11. อัปเดตตั้งชื่อเล่น/ชื่อบันทึกของลูกค้าในระบบหลังบ้าน CRM
app.put('/customers/:id/nickname', async (req, res) => {
  try {
    const updated = await prisma.customer.update({ where: { id: req.params.id }, data: { nickname: req.body.nickname } });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

// 12. 🏷️ [ฟีเจอร์เด็ด] อัปเดตข้อมูลแท็กป้ายกำกับลูกค้าสไตล์ OA Official (VIP, เล่นหนัก)
app.put('/customers/:id/tags', async (req, res) => {
  try {
    const updated = await prisma.customer.update({ 
      where: { id: req.params.id }, 
      data: { tags: req.body.tags } 
    });
    res.json(updated);
  } catch (error) { 
    res.status(500).send(error.message); 
  }
});

// 13. ระบบปิดเคส/เปิดงานใหม่ (สลับแท็บ ACTIVE / RESOLVED แบบ Pedpro)
app.put('/conversations/:id/status', async (req, res) => {
  try {
    const updated = await prisma.conversation.update({ where: { id: req.params.id }, data: { status: req.body.status } });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

// 14. ระบบกดรับเรื่องมอบหมายงานคุมเคสลูกค้า (แชทของฉัน / ปลดมอบหมาย)
app.put('/conversations/:id/assign', async (req, res) => {
  try {
    const updated = await prisma.conversation.update({ where: { id: req.params.id }, data: { assigneeId: req.body.adminId } });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

// ====================================================================
// 🚀 สั่งเปิดประตูมิติตั้งตารับสายแชททั่วสารทิศ
// ====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 เอนจิ้นคุมพลังหลังบ้านร่างทองคำ V.Final พร้อมรบเต็มพิกัดที่พอร์ต ${PORT}`);
});