import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const TG = `https://api.telegram.org/bot${process.env.TG_TOKEN}`;

async function tg(method, payload) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

function send(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');

  // 텔레그램이 보낸 요청인지 시크릿 헤더로 검증
  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.TG_SECRET) {
    return res.status(401).send('unauthorized');
  }

  const update = req.body;

  try {
    // ── 1. 발신 채널에 글이 올라온 경우 → 전체 수신자에게 일대일 발송 ──
    if (update.channel_post) {
      const post = update.channel_post;

      // CHANNEL_ID가 설정돼 있으면 해당 채널의 글만 브로드캐스트
      if (process.env.CHANNEL_ID && String(post.chat.id) !== process.env.CHANNEL_ID) {
        return res.status(200).send('ignored');
      }

      const recipients = await sql`SELECT chat_id, name FROM recipients`;

      const results = await Promise.allSettled(
        recipients.map((r) =>
          tg('copyMessage', {
            chat_id: r.chat_id,
            from_chat_id: post.chat.id,
            message_id: post.message_id,
          }).then((j) => {
            if (!j.ok) throw new Error(`${r.name || r.chat_id}: ${j.description}`);
            return r;
          })
        )
      );

      // 실패 건이 있으면 관리자에게 리포트
      const failed = results.filter((x) => x.status === 'rejected');
      if (failed.length > 0 && process.env.ADMIN_CHAT_ID) {
        const lines = failed.map((x) => x.reason.message).join('\n');
        await send(
          process.env.ADMIN_CHAT_ID,
          `발송 실패 ${failed.length}건 (성공 ${results.length - failed.length}건)\n${lines}`
        );
      }

      return res.status(200).send('ok');
    }

    // ── 2. 개인 DM으로 들어온 메시지 처리 (/start 등록, 관리자 명령어) ──
    if (update.message && update.message.chat.type === 'private') {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = (msg.text || '').trim();
      const from = msg.from || {};
      const name =
        [from.first_name, from.last_name].filter(Boolean).join(' ') +
        (from.username ? ` (@${from.username})` : '');
      const isAdmin = String(chatId) === process.env.ADMIN_CHAT_ID;

      if (text.startsWith('/start')) {
        await sql`
          INSERT INTO recipients (chat_id, name)
          VALUES (${chatId}, ${name})
          ON CONFLICT (chat_id) DO UPDATE SET name = ${name}
        `;
        await send(
          chatId,
          [
            '등록이 완료되었습니다. 앞으로 콜 메세지를 이 채팅으로 받게 됩니다.',
            '',
            '[안내사항]',
            '안녕하세요 교보증권 이상호 연구원입니다. 조금 더 효율적으로 메세지 송부를 위해서 call bot 등록을 요청 드렸습니다 응해주셔서 감사합니다. 좋은 아이디어를 조금 더 많이 콜하며 업무에 도움이 되도록 보답하겠습니다. 오늘도 좋은하루 되십시오.',
            '',
            '* 이 봇은 발송 전용입니다. 이 채팅에 남기신 메시지는 발신자에게 전달되지 않습니다.',
            '* 문의 및 회신은 발신자에게 직접 연락 부탁드립니다.',
            '* 수신을 중단하시려면 /stop, 다시 받으시려면 /start 를 입력해주세요.',
          ].join('\n')
        );
        return res.status(200).send('ok');
      }

      if (text.startsWith('/stop')) {
        await sql`DELETE FROM recipients WHERE chat_id = ${chatId}`;
        await send(chatId, '수신이 중단되었습니다. 다시 받으시려면 /start 를 입력해주세요.');
        return res.status(200).send('ok');
      }

      // ── 관리자 전용 명령어 ──
      if (isAdmin && text.startsWith('/list')) {
        const rows = await sql`SELECT chat_id, name, added_at FROM recipients ORDER BY added_at`;
        if (rows.length === 0) {
          await send(chatId, '등록된 수신자가 없습니다.');
        } else {
          const lines = rows
            .map((r, i) => `${i + 1}. ${r.name || '(이름없음)'} — ${r.chat_id}`)
            .join('\n');
          await send(chatId, `수신자 ${rows.length}명\n${lines}`);
        }
        return res.status(200).send('ok');
      }

      if (isAdmin && text.startsWith('/remove')) {
        const target = text.split(/\s+/)[1];
        if (!target) {
          await send(chatId, '사용법: /remove chat_id\n(/list 로 chat_id 확인)');
        } else {
          const del = await sql`DELETE FROM recipients WHERE chat_id = ${target} RETURNING chat_id`;
          await send(
            chatId,
            del.length > 0 ? `삭제 완료: ${target}` : `해당 chat_id가 없습니다: ${target}`
          );
        }
        return res.status(200).send('ok');
      }

      // 그 외 메시지에는 안내만
      await send(
        chatId,
        isAdmin
          ? '명령어: /list (수신자 목록), /remove chat_id (수신자 삭제)'
          : [
              '이 봇은 콜 메시지 발송 전용입니다.',
              '이 채팅에 남기신 메시지는 발신자에게 전달되지 않습니다. 문의는 발신자에게 직접 연락 부탁드립니다.',
              '',
              '수신 중단 /stop · 수신 재개 /start',
            ].join('\n')
      );
      return res.status(200).send('ok');
    }

    return res.status(200).send('ok');
  } catch (e) {
    console.error(e);
    // 텔레그램은 200이 아니면 같은 업데이트를 계속 재전송하므로 항상 200 반환
    return res.status(200).send('error-logged');
  }
}
