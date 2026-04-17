export default {
  async fetch(request, env, ctx) {
    console.log("Nhận yêu cầu:", request.method, request.url);
    
    // Xử lý đường dẫn đặc biệt: Thiết lập Webhook
    const url = new URL(request.url);
    if (url.pathname === '/setup-webhook') {
      return handleSetupWebhook(request, env);
    }
    
    try {
      return handleRequest(request, env);
    } catch (error) {
      console.error("Lỗi ở hàm chính:", error);
      return new Response('Đã xảy ra lỗi khi xử lý yêu cầu', { status: 500 });
    }
  }
};

// Hàm xử lý thiết lập Webhook
async function handleSetupWebhook(request, env) {
  if (request.method !== 'GET') {
    return new Response('Chỉ chấp nhận yêu cầu GET', { status: 405 });
  }
  
  const BOT_TOKEN = env.BOT_TOKEN;
  
  if (!BOT_TOKEN) {
    return new Response('BOT_TOKEN chưa được cấu hình', { status: 500 });
  }
  
  const url = new URL(request.url);
  const workerUrl = `${url.protocol}//${url.hostname}`;
  
  console.log(`Đang thiết lập Webhook, URL của Worker: ${workerUrl}`);
  
  try {
    const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const response = await fetch(`${API_URL}/setWebhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: workerUrl,
        allowed_updates: ["message"]
      }),
    });
    
    const result = await response.json();
    console.log('Kết quả thiết lập Webhook:', result);
    
    if (result.ok) {
      return new Response(`Thiết lập Webhook thành công: ${workerUrl}`, { status: 200 });
    } else {
      return new Response(`Thiết lập Webhook thất bại: ${JSON.stringify(result)}`, { status: 500 });
    }
  } catch (error) {
    console.error('Lỗi khi thiết lập Webhook:', error);
    return new Response(`Lỗi khi thiết lập Webhook: ${error.message}`, { status: 500 });
  }
}

// Hàm xử lý logic chính, hiện nhận đối tượng env làm tham số
async function handleRequest(request, env) {
  const IMG_BED_URL = env.IMG_BED_URL;
  const BOT_TOKEN = env.BOT_TOKEN;
  const AUTH_CODE = env.AUTH_CODE; // Mã xác thực tùy chọn
  const ADMIN_USERS = env.ADMIN_USERS ? env.ADMIN_USERS.split(',').map(id => id.trim()) : []; // Danh sách ID người dùng quản trị viên

  // Kiểm tra xem các biến môi trường cần thiết có tồn tại không
  if (!IMG_BED_URL || !BOT_TOKEN) {
    console.error("Thiếu biến môi trường: IMG_BED_URL=", !!IMG_BED_URL, "BOT_TOKEN=", !!BOT_TOKEN);
    return new Response('Các biến môi trường cần thiết (IMG_BED_URL, BOT_TOKEN) chưa được cấu hình', { status: 500 });
  }
  
  // Kiểm tra và thực hiện tự động dọn dẹp (đặt ở đầu quá trình xử lý yêu cầu để tránh dọn dẹp thường xuyên)
  try {
    await checkAndExecuteAutoClean(env);
  } catch (error) {
    console.error("Đã xảy ra lỗi khi kiểm tra tự động dọn dẹp:", error);
  }

  console.log("Kiểm tra biến môi trường thành công: IMG_BED_URL=", IMG_BED_URL.substring(0, 8) + '...', "AUTH_CODE=", AUTH_CODE ? '[Đã thiết lập]' : '[Chưa thiết lập]');

  // API_URL hiện được xây dựng dựa trên BOT_TOKEN khi cần thiết
  const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

  if (request.method !== 'POST') {
    console.log("Yêu cầu không phải POST bị từ chối");
    return new Response('Chỉ chấp nhận yêu cầu POST', { status: 405 });
  }

  try {
    const update = await request.json();
    console.log("Nhận cập nhật từ Telegram, loại tin nhắn:", update.message ? Object.keys(update.message).filter(k => ['text', 'photo', 'video', 'document', 'audio', 'animation'].includes(k)).join(',') : 'no message');
    
    if (!update.message) return new Response('OK', { status: 200 });

    const message = update.message;
    const chatId = message.chat.id;
    const userId = message.from.id; // Lấy ID người dùng
    const username = message.from.username || 'Người dùng ẩn danh';
    const text = message.text?.trim();
    
    // Kiểm tra xem người dùng có bị chặn sử dụng bot không
    const isBanned = await isUserBanned(userId, env);
    const isAdmin = ADMIN_USERS.includes(userId.toString());
    
    // Nếu người dùng bị chặn và không phải là quản trị viên, từ chối xử lý yêu cầu
    if (isBanned && !isAdmin) {
      await sendMessage(chatId, `⛔ Rất tiếc, bạn đã bị quản trị viên hạn chế sử dụng bot này. Để xóa bỏ hạn chế, vui lòng liên hệ với quản trị viên.`, env);
      return new Response('OK', { status: 200 });
    }

    // Kiểm tra xem bot có đang ở chế độ công khai không
    const isPublicMode = await getBotPublicMode(env);
    if (!isPublicMode && !isAdmin) {
      await sendMessage(chatId, `⛔ Bot hiện đang ở chế độ riêng tư, chỉ quản trị viên mới có quyền sử dụng.`, env);
      return new Response('OK', { status: 200 });
    }

    // Xử lý các lệnh
    if (text && text.startsWith('/')) {
      console.log("Nhận lệnh:", text);
      const command = text.split(' ')[0];
      
      // Lệnh quản trị
      if (command === '/admin' && isAdmin) {
        const subCommand = text.split(' ')[1]?.toLowerCase();
        const targetId = text.split(' ')[2];
        
        if (!subCommand) {
          // Hiển thị trợ giúp quản trị
          await sendMessage(chatId, `🔐 *Bảng lệnh quản trị*\n\nCác lệnh quản trị hiện có:\n\n/admin ban [ID người dùng] - Hạn chế người dùng chỉ định\n/admin unban [ID người dùng] - Gỡ bỏ hạn chế người dùng chỉ định\n/admin list - Xem tất cả người dùng bị hạn chế\n/admin users - Xem tất cả người dùng đã từng sử dụng bot\n/admin stats - Xem thống kê sử dụng bot\n/admin broadcast [Tin nhắn] - Gửi thông báo tới tất cả người dùng\n/admin autoclean [Số ngày] - Tự động xóa nội dung từ bao nhiêu ngày trước\n/admin autoclean status - Xem cấu hình dọn dẹp hiện tại\n/admin mode - Bật/tắt chế độ bot công khai (Public/Private)\n/admin uploadfolder [đường dẫn] - Đặt thư mục upload lưu trữ mặc định\n/admin uploadfolder reset - Đặt lại thư mục upload mặc định`, env);
          return new Response('OK', { status: 200 });
        }
        
        if (subCommand === 'mode') {
          let newMode;
          if (targetId && targetId.toLowerCase() === 'public') {
            newMode = true;
          } else if (targetId && targetId.toLowerCase() === 'private') {
            newMode = false;
          } else {
            await sendMessage(chatId, `⚠️ Vui lòng gõ thêm tham số cấu hình: \`/admin mode public\` hoặc \`/admin mode private\``, env);
            return new Response('OK', { status: 200 });
          }
          const savedMode = await updateBotPublicMode(newMode, env);
          if (!savedMode) {
            await sendMessage(chatId, `❌ Lỗi: Không thể lưu cấu hình chế độ vào KV Storage. Kiểm tra lại binding STATS_STORAGE trong Cloudflare Dashboard.`, env);
          } else {
            // Xác minh lại bằng cách đọc KV ngay sau khi lưu
            const verifyMode = await getBotPublicMode(env);
            const modeLabel = newMode ? 'CÔNG KHAI' : 'RIÊNG TƯ';
            const verifyLabel = verifyMode ? 'CÔNG KHAI' : 'RIÊNG TƯ';
            if (verifyMode !== newMode) {
              await sendMessage(chatId, `⚠️ Cảnh báo: Đã ghi vào KV nhưng đọc lại trả về ${verifyLabel} thay vì ${modeLabel}. Có thể KV chưa đồng bộ, thử lại sau vài giây.`, env);
            } else {
              await sendMessage(chatId, `✅ Đã chuyển bot sang chế độ ${newMode ? 'CÔNG KHAI (Mọi người đều dùng được)' : 'RIÊNG TƯ (Chỉ admin dùng được)'}\n\n🔍 Đã xác minh: KV Storage hiện lưu chế độ = ${verifyLabel}`, env);
            }
          }
          return new Response('OK', { status: 200 });
        }
        
        if (subCommand === 'uploadfolder') {
          let folder = text.split(' ').slice(2).join(' ').trim();
          if (!folder) {
            const currentFolder = await getUploadFolder(env);
            await sendMessage(chatId, `📂 Thư mục upload hiện tại: \`${currentFolder}\`\n\nĐể thay đổi, hãy dùng:\n/admin uploadfolder [đường dẫn]\nVí dụ: /admin uploadfolder img/test\n\nDùng /admin uploadfolder reset để đặt lại về thư mục gốc`, env);
            return new Response('OK', { status: 200 });
          }

          // Cho phép reset về thư mục gốc
          if (folder.toLowerCase() === 'reset') {
            folder = '/';
          } else {
            // Loại bỏ dấu '/' ở đầu để API nhận diện đúng đây là đường dẫn tương đối
            while (folder.startsWith('/')) {
              folder = folder.substring(1);
            }
            if (folder === '') {
              folder = '/';
            }
          }
          
          try {
            await updateUploadFolder(folder, env);
            // Xác minh bằng cách đọc lại ngay sau khi lưu
            const verifyFolder = await getUploadFolder(env);
            if (verifyFolder !== folder) {
              await sendMessage(chatId, `⚠️ Cảnh báo: Đã ghi vào KV nhưng đọc lại trả về \`${verifyFolder}\` thay vì \`${folder}\`. Có thể KV chưa đồng bộ.`, env);
            } else {
              const folderDisplay = folder === '/' ? 'Thư mục gốc (/)' : folder;
              await sendMessage(chatId, `✅ Đã cập nhật thư mục upload: \`${folderDisplay}\`\n\n🔍 Đã xác minh: KV Storage lưu = \`${verifyFolder}\``, env);
            }
          } catch (kvError) {
            console.error('Lỗi KV khi lưu upload_folder:', kvError);
            await sendMessage(chatId, `❌ Lỗi KV Storage khi lưu thư mục upload:\n\`${kvError.message || String(kvError)}\`\n\nDebug info:\n- folder value: \`${folder}\`\n- folder type: ${typeof folder}\n- STATS_STORAGE exists: ${!!env.STATS_STORAGE}`, env);
          }
          return new Response('OK', { status: 200 });
        }
        
        if (subCommand === 'copy') {
          const val = targetId && targetId.toLowerCase();
          if (val === 'on' || val === 'off') {
            const newMode = val === 'on';
            try {
              await updateCopyMode(newMode, env);
              const verify = await getCopyMode(env);
              const verifyOk = verify === newMode;
              const modeDesc = newMode
                ? '⚡ Bot sẽ forward file sang kênh Telegram của CF-imgbed (không tải về Worker), ghi trực tiếp vào KV của CF-imgbed.\nCần cấu hình: /admin cfstatus để kiểm tra.\nFallback re-upload nếu thiếu cấu hình.'
                : '📦 Bot sẽ tải file từ Telegram về rồi upload lại lên CF-imgbed như cũ.';
              await sendMessage(chatId, `✅ Copy Mode đã ${newMode ? '⚡ BẬT' : '❌ TẮT'}\n🔍 Xác minh KV: ${verifyOk ? '✓ OK' : '⚠️ Không khớp, thử lại'}\n\n${modeDesc}`, env);
            } catch(e) {
              await sendMessage(chatId, `❌ Lỗi KV: ${e.message}`, env);
            }
          } else {
            const currentMode = await getCopyMode(env);
            await sendMessage(chatId, `⚡ Copy Mode hiện tại: ${currentMode ? '⚡ BẬT' : '❌ TẮT'}\n\n📖 Cách hoạt động:\n• Bot forward file vào kênh TG của CF-imgbed (dùng bot token CF-imgbed)\n• Lấy file_id mới từ kênh đó\n• Ghi metadata trực tiếp vào KV của CF-imgbed\n→ File không bao giờ đi qua RAM/băng thông Worker!\n\n/admin copy on   → Bật\n/admin copy off  → Tắt\n/admin cfstatus  → Kiểm tra cấu hình Copy Mode`, env);
          }
          return new Response('OK', { status: 200 });
        }

        if (subCommand === 'cftoken') {
          const tokenInput = text.split(' ').slice(2).join(' ').trim();
          if (!tokenInput) {
            const currentToken = await getImgBedAdminToken(env);
            const masked = currentToken
              ? `${currentToken.substring(0, 4)}${'*'.repeat(Math.max(0, currentToken.length - 8))}${currentToken.slice(-4)}`
              : 'Chưa đặt';
            await sendMessage(chatId, `🔑 CF-imgbed Admin Token: \`${masked}\`\n\nToken dùng cho /api/manage/* (Copy Mode nâng cao, xem danh sách file).\n\nĐặt: /admin cftoken <token>\nXóa: /admin cftoken clear`, env);
            return new Response('OK', { status: 200 });
          }
          if (tokenInput.toLowerCase() === 'clear') {
            try {
              if (env.STATS_STORAGE) await env.STATS_STORAGE.delete('imgbed_admin_token');
              await sendMessage(chatId, `✅ Đã xóa CF-imgbed Admin Token`, env);
            } catch(e) {
              await sendMessage(chatId, `❌ Lỗi: ${e.message}`, env);
            }
            return new Response('OK', { status: 200 });
          }
          try {
            await updateImgBedAdminToken(tokenInput, env);
            const masked = `${tokenInput.substring(0, 4)}${'*'.repeat(Math.max(0, tokenInput.length - 8))}${tokenInput.slice(-4)}`;
            await sendMessage(chatId, `✅ Đã lưu CF-imgbed Admin Token: \`${masked}\``, env);
          } catch(e) {
            await sendMessage(chatId, `❌ Lỗi KV: ${e.message}`, env);
          }
          return new Response('OK', { status: 200 });
        }

        // ── CF-imgbed Cross-Account Copy Mode Config ──────────────────────
        // Mỗi lệnh đều kiểm tra env var trước, nếu không có thì đọc/ghi KV

        if (subCommand === 'cfbottoken') {
          const val = text.split(' ').slice(2).join(' ').trim();
          if (!val) {
            const cur = await getCfBotToken(env);
            const masked = cur ? `${cur.substring(0, 6)}${'*'.repeat(Math.max(0, cur.length - 12))}${cur.slice(-6)}` : 'Chưa đặt';
            await sendMessage(chatId, `🤖 CF-imgbed Bot Token: \`${masked}\`\n\nLà token của bot Telegram mà CF-imgbed đang dùng.\nTìm trong file backup CF-imgbed (trường TgBotToken).\n\nEnv var (ưu tiên cao hơn): IMGBED_CF_BOT_TOKEN\n\nĐặt: /admin cfbottoken <token>\nXóa: /admin cfbottoken clear`, env);
          } else if (val.toLowerCase() === 'clear') {
            if (env.STATS_STORAGE) await env.STATS_STORAGE.delete('imgbed_cf_bot_token');
            await sendMessage(chatId, '✅ Đã xóa CF Bot Token', env);
          } else {
            await setKvConfig('imgbed_cf_bot_token', val, env);
            const masked = `${val.substring(0, 6)}${'*'.repeat(Math.max(0, val.length - 12))}${val.slice(-6)}`;
            await sendMessage(chatId, `✅ Đã lưu CF Bot Token: \`${masked}\``, env);
          }
          return new Response('OK', { status: 200 });
        }

        if (subCommand === 'cfchatid') {
          const val = text.split(' ').slice(2).join(' ').trim();
          if (!val) {
            const cur = await getCfChatId(env);
            await sendMessage(chatId, `💬 CF-imgbed Chat ID: \`${cur || 'Chưa đặt'}\`\n\nLà chat_id kênh Telegram lưu file của CF-imgbed.\nTìm trong file backup CF-imgbed (trường TgChatId), ví dụ: -1001234567890.\n\nEnv var (ưu tiên cao hơn): IMGBED_TG_CHAT_ID\n\nĐặt: /admin cfchatid <id>\nXóa: /admin cfchatid clear`, env);
          } else if (val.toLowerCase() === 'clear') {
            if (env.STATS_STORAGE) await env.STATS_STORAGE.delete('imgbed_tg_chat_id');
            await sendMessage(chatId, '✅ Đã xóa CF Chat ID', env);
          } else {
            await setKvConfig('imgbed_tg_chat_id', val, env);
            await sendMessage(chatId, `✅ Đã lưu CF Chat ID: \`${val}\``, env);
          }
          return new Response('OK', { status: 200 });
        }

        if (subCommand === 'cfchannel') {
          const val = text.split(' ').slice(2).join(' ').trim();
          if (!val) {
            const cur = await getCfChannelName(env);
            await sendMessage(chatId, `📺 CF-imgbed Channel Name: \`${cur || 'Chưa đặt'}\`\n\nTên hiển thị kênh trong metadata (ví dụ: ATP_Img).\nTham khảo trường ChannelName trong backup.\n\nEnv var: IMGBED_CHANNEL_NAME\n\nĐặt: /admin cfchannel <tên>`, env);
          } else {
            await setKvConfig('imgbed_channel_name', val, env);
            await sendMessage(chatId, `✅ Đã lưu Channel Name: \`${val}\``, env);
          }
          return new Response('OK', { status: 200 });
        }

        if (subCommand === 'cfapitoken') {
          const val = text.split(' ').slice(2).join(' ').trim();
          if (!val) {
            const cur = await getCfApiToken(env);
            const masked = cur ? `${cur.substring(0, 4)}${'*'.repeat(Math.max(0, cur.length - 8))}${cur.slice(-4)}` : 'Chưa đặt';
            await sendMessage(chatId, `🔑 Cloudflare API Token: \`${masked}\`\n\nDùng để ghi KV của CF-imgbed từ account CF khác.\nTạo tại: CF Dashboard → My Profile → API Tokens → Create Token\nQuyền cần có: KV Storage (Edit) cho account CF-imgbed.\n\nEnv var (ưu tiên cao hơn): IMGBED_CF_API_TOKEN\n\nĐặt: /admin cfapitoken <token>\nXóa: /admin cfapitoken clear`, env);
          } else if (val.toLowerCase() === 'clear') {
            if (env.STATS_STORAGE) await env.STATS_STORAGE.delete('imgbed_cf_api_token');
            await sendMessage(chatId, '✅ Đã xóa CF API Token', env);
          } else {
            await setKvConfig('imgbed_cf_api_token', val, env);
            const masked = `${val.substring(0, 4)}${'*'.repeat(Math.max(0, val.length - 8))}${val.slice(-4)}`;
            await sendMessage(chatId, `✅ Đã lưu CF API Token: \`${masked}\``, env);
          }
          return new Response('OK', { status: 200 });
        }

        if (subCommand === 'cfaccid') {
          const val = text.split(' ').slice(2).join(' ').trim();
          if (!val) {
            const cur = await getCfAccountId(env);
            await sendMessage(chatId, `👤 Cloudflare Account ID: \`${cur || 'Chưa đặt'}\`\n\nAccount ID của account Cloudflare chứa CF-imgbed.\nTìm tại: CF Dashboard → bên phải trang chủ → Account ID.\n\nEnv var: IMGBED_CF_ACCOUNT_ID\n\nĐặt: /admin cfaccid <id>`, env);
          } else {
            await setKvConfig('imgbed_cf_account_id', val, env);
            await sendMessage(chatId, `✅ Đã lưu CF Account ID: \`${val}\``, env);
          }
          return new Response('OK', { status: 200 });
        }

        if (subCommand === 'cfkvid') {
          const val = text.split(' ').slice(2).join(' ').trim();
          if (!val) {
            const cur = await getCfKvNamespaceId(env);
            await sendMessage(chatId, `🗂️ CF-imgbed KV Namespace ID: \`${cur || 'Chưa đặt'}\`\n\nID của KV namespace nơi CF-imgbed lưu dữ liệu file.\nTìm tại: CF Dashboard (account CF-imgbed) → Storage → KV → tìm namespace của CF-imgbed.\n\nEnv var: IMGBED_KV_NAMESPACE_ID\n\nĐặt: /admin cfkvid <id>`, env);
          } else {
            await setKvConfig('imgbed_kv_namespace_id', val, env);
            await sendMessage(chatId, `✅ Đã lưu KV Namespace ID: \`${val}\``, env);
          }
          return new Response('OK', { status: 200 });
        }

        if (subCommand === 'cfstatus') {
          const [copyMode, adminToken, cfChatId, cfChannelName, cfApiToken, cfAccId, cfKvId] = await Promise.all([
            getCopyMode(env), getImgBedAdminToken(env), getCfChatId(env), getCfChannelName(env),
            getCfApiToken(env), getCfAccountId(env), getCfKvNamespaceId(env)
          ]);
          const hasDirectBinding = !!env.IMGBED_KV;
          const hasApiMethod = !!(cfApiToken && cfAccId && cfKvId);
          const hasAdminToken = !!adminToken;
          const hasChatIdCache = !!cfChatId;

          const maskStr = (s) => s ? `${s.substring(0, 4)}${'*'.repeat(Math.max(0, s.length - 8))}${s.slice(-4)} ✅` : '❌ Chưa đặt';
          const showId = (s) => s ? `${s.substring(0, 8)}... ✅` : '❌ Chưa đặt';

          let kvMethod = '';
          if (hasDirectBinding) kvMethod = '✅ IMGBED_KV binding (cùng account) — nhanh nhất';
          else if (hasApiMethod) kvMethod = '✅ Cloudflare REST API (khác account)';
          else kvMethod = '❌ Chưa cấu hình';

          let channelStatus = '';
          if (hasChatIdCache) channelStatus = `${cfChatId} ✅${cfChannelName ? ' — ' + cfChannelName : ''}`;
          else if (hasAdminToken) channelStatus = '🔍 Auto-discover lần đầu upload';
          else channelStatus = '❌ Chưa có';

          let status = `📊 *Trạng thái Copy Mode*\n\n`;
          status += `Copy Mode: ${copyMode ? '⚡ BẬT — lỗi = báo ngay, không fallback' : '❌ TẮT — dùng re-upload thông thường'}\n\n`;
          status += `*[Telegram Forward]*\n`;
          status += `• Bot dùng: BOT_TOKEN của bot này (không cần cfbottoken)\n`;
          status += `• Bot phải là admin kênh TG CF-imgbed ✏️\n`;
          status += `• Kênh CF-imgbed: ${channelStatus}\n\n`;
          status += `*[Channel Auto-Discovery]*\n`;
          status += `• Admin Token (cftoken): ${maskStr(adminToken)}\n`;
          if (hasAdminToken) status += `• → Tự lấy TgChatId + ChannelName qua API CF-imgbed\n`;
          else status += `• → Cần: /admin cftoken <token> để bật auto-discover\n`;
          if (hasChatIdCache) status += `• Override thủ công: cfchatid=${cfChatId}${cfChannelName ? ', cfchannel=' + cfChannelName : ''}\n`;
          status += '\n';
          status += `*[KV Write Method]*\n`;
          status += `• Phương thức: ${kvMethod}\n`;
          if (!hasDirectBinding) {
            status += `• CF API Token: ${maskStr(cfApiToken)}\n`;
            status += `• Account ID: ${showId(cfAccId)}\n`;
            status += `• KV Namespace ID: ${showId(cfKvId)}\n`;
          }
          if (copyMode) {
            const issues = [];
            if (!hasAdminToken && !hasChatIdCache) issues.push('❌ Thiếu channel info: /admin cftoken <token>');
            if (!hasDirectBinding && !hasApiMethod) issues.push('❌ Thiếu KV write:\n  Cùng account: thêm IMGBED_KV binding vào wrangler.toml\n  Khác account: /admin cfapitoken + /admin cfaccid + /admin cfkvid');
            if (issues.length > 0) status += `\n⚠️ *Copy Mode BẬT nhưng chưa đủ cấu hình:*\n${issues.join('\n')}`;
            else status += `\n✅ Cấu hình đầy đủ. Gửi file để thử!`;
          }
          await sendMessage(chatId, status, env);
          return new Response('OK', { status: 200 });
        }

        if (subCommand === 'ban' && targetId) {
          await banUser(targetId, username, env);
          await sendMessage(chatId, `✅ Đã hạn chế người dùng ${targetId} sử dụng bot`, env);
          return new Response('OK', { status: 200 });
        }
        
        if (subCommand === 'unban' && targetId) {
          await unbanUser(targetId, env);
          await sendMessage(chatId, `✅ Đã gỡ bỏ hạn chế đối với người dùng ${targetId}`, env);
          return new Response('OK', { status: 200 });
        }
        
        if (subCommand === 'list') {
          const bannedUsers = await getBannedUsers(env);
          if (bannedUsers.length === 0) {
            await sendMessage(chatId, `📋 Hiện không có người dùng nào bị hạn chế`, env);
          } else {
            let message = `📋 *Danh sách người dùng bị hạn chế*\n\n`;
            bannedUsers.forEach((user, index) => {
              message += `${index + 1}. ID người dùng: ${user.userId}\n   Lý do: ${user.reason || 'Không rõ'}\n   Thời gian chặn: ${formatDate(user.bannedAt)}\n   Admin thực hiện: ${user.bannedBy || 'Không rõ'}\n\n`;
            });
            await sendMessage(chatId, message, env);
          }
          return new Response('OK', { status: 200 });
        }
        
        if (subCommand === 'users') {
          // Lấy thông tin chi tiết của tất cả người dùng
          const usersList = await getAllUsersDetails(env);
          
          if (usersList.length === 0) {
            await sendMessage(chatId, `📋 Hiện chưa có người dùng nào sử dụng bot`, env);
          } else {
            let message = `👥 *Danh sách người dùng* (Tổng cộng ${usersList.length} người)\n\n`;
            
            // Thêm chức năng phân trang
            const page = parseInt(targetId) || 1;
            const itemsPerPage = 10;
            const totalPages = Math.ceil(usersList.length / itemsPerPage);
            const startIndex = (page - 1) * itemsPerPage;
            const endIndex = Math.min(startIndex + itemsPerPage, usersList.length);
            
            message += `📄 Trang hiện tại: ${page}/${totalPages}\n\n`;
            
            // Chỉ hiển thị người dùng của trang hiện tại
            const pageUsers = usersList.slice(startIndex, endIndex);
            
            for (let i = 0; i < pageUsers.length; i++) {
              const user = pageUsers[i];
              const userNumber = startIndex + i + 1;
              const isBanned = await isUserBanned(user.userId, env);
              
              message += `${userNumber}. ID người dùng: ${user.userId}\n`;
              message += `   Tên người dùng: ${user.username || 'Không rõ'}\n`;
              message += `   Sử dụng lần đầu: ${formatDate(user.firstSeen)}\n`;
              message += `   Sử dụng lần cuối: ${formatDate(user.lastSeen)}\n`;
              
              // Lấy thống kê tải lên của người dùng đó
              const userStats = await getUserStats(user.userId, env);
              message += `   Số tệp tải lên: ${userStats.totalUploads || 0} tệp\n`;
              message += `   Dung lượng: ${formatFileSize(userStats.totalSize || 0)}\n`;
              message += `   Trạng thái: ${isBanned ? '⛔ Đã hạn chế' : '✅ Bình thường'}\n\n`;
            }
            
            // Thêm hướng dẫn chuyển trang
            if (totalPages > 1) {
              message += `\nLệnh chuyển trang:\n`;
              if (page > 1) {
                message += `/admin users ${page - 1} - Trang trước\n`;
              }
              if (page < totalPages) {
                message += `/admin users ${page + 1} - Trang sau\n`;
              }
            }
            
            await sendMessage(chatId, message, env);
          }
          return new Response('OK', { status: 200 });
        }
        
        if (subCommand === 'stats') {
          // Lấy thống kê sử dụng bot
          const stats = await getBotStats(env);
          let message = `📊 *Thống kê sử dụng bot*\n\n`;
          message += `👥 Tổng số người dùng: ${stats.totalUsers || 0}\n`;
          message += `📤 Tổng số tệp tải lên: ${stats.totalUploads || 0}\n`;
          message += `📦 Tổng dung lượng: ${formatFileSize(stats.totalSize || 0)}\n`;
          message += `⛔ Số người dùng bị hạn chế: ${stats.bannedUsers || 0}\n`;
          await sendMessage(chatId, message, env);
          return new Response('OK', { status: 200 });
        }
        
        if (subCommand === 'broadcast' && text.split(' ').slice(2).join(' ')) {
          const broadcastMessage = text.split(' ').slice(2).join(' ');
          // Lấy tất cả người dùng và gửi thông báo
          const users = await getAllUsers(env);
          
          await sendMessage(chatId, `🔄 Đang gửi thông báo tới ${users.length} người dùng...`, env);
          
          let successCount = 0;
          for (const user of users) {
            try {
              await sendMessage(user, `📢 *THÔNG BÁO TỪ QUẢN TRỊ VIÊN*\n\n${broadcastMessage}`, env);
              successCount++;
            } catch (error) {
              console.error(`Gửi thông báo tới người dùng ${user} thất bại:`, error);
            }
          }
          
          await sendMessage(chatId, `✅ Hoàn tất! Gửi thành công cho ${successCount}/${users.length} người dùng`, env);
          return new Response('OK', { status: 200 });
        }
        
        if (subCommand === 'autoclean') {
          // Lấy tham số thứ ba là số ngày hoặc lệnh
          const daysOrCommand = text.split(' ')[2];
          
          if (!daysOrCommand) {
            await sendMessage(chatId, `❌ Vui lòng chỉ định số ngày để tự động xóa, ví dụ:\n/admin autoclean 30\n\nHoặc xem cấu hình hiện tại:\n/admin autoclean status`, env);
            return new Response('OK', { status: 200 });
          }
          
          if (daysOrCommand.toLowerCase() === 'status') {
            // Xem cấu hình tự động dọn dẹp hiện tại
            const settings = await getAutoCleanSettings(env);
            if (settings && settings.enabled) {
              await sendMessage(chatId, `⚙️ *Cấu hình tự động dọn dẹp*\n\n✅ Trạng thái: Đang bật\n⏰ Thời gian: Xóa nội dung hơn ${settings.days} ngày tuổi\n🕒 Cập nhật lúc: ${formatDate(settings.updatedAt)}\n\nĐể thay đổi cấu hình, sử dụng:\n/admin autoclean [Số ngày]\n\nĐể tắt tự động dọn dẹp, sử dụng:\n/admin autoclean 0`, env);
            } else {
              await sendMessage(chatId, `⚙️ *Cấu hình tự động dọn dẹp*\n\n❌ Trạng thái: Đang tắt\n\nĐể bật tính năng, sử dụng:\n/admin autoclean [Số ngày]`, env);
            }
            return new Response('OK', { status: 200 });
          }
          
          // Phân tích số ngày
          const days = parseInt(daysOrCommand);
          if (isNaN(days) || days < 0) {
            await sendMessage(chatId, `❌ Số ngày phải là số nguyên lớn hơn hoặc bằng 0. 0 nghĩa là tắt tự động dọn dẹp.`, env);
            return new Response('OK', { status: 200 });
          }
          
          // Cập nhật cấu hình tự động dọn dẹp
          if (days === 0) {
            // Tắt tự động dọn dẹp
            await updateAutoCleanSettings({ enabled: false }, env);
            await sendMessage(chatId, `✅ Đã tắt tính năng tự động dọn dẹp.`, env);
          } else {
            // Bật tự động dọn dẹp
            await updateAutoCleanSettings({ enabled: true, days: days }, env);
            await sendMessage(chatId, `✅ Đã thiết lập tự động dọn dẹp nội dung hơn ${days} ngày tuổi.\n\nHệ thống sẽ kiểm tra và dọn dẹp các bản ghi phù hợp trong mỗi lần nhận yêu cầu.`, env);
            
            // Thực hiện dọn dẹp ngay lập tức một lần
            const cleanedCount = await cleanOldRecords(days, env);
            await sendMessage(chatId, `🧹 Đã dọn dẹp ngay lập tức ${cleanedCount} bản ghi phù hợp.`, env);
          }
          
          return new Response('OK', { status: 200 });
        }
      }
      
      // Thêm lệnh tải lên phân đoạn
      if (command === '/chunk_upload' || command === '/chunk' || command === '/chunk_start') {
        await handleChunkUploadStart(chatId, userId, message, env);
        return new Response('OK', { status: 200 });
      }
      
      // Xử lý lệnh hủy tải lên phân đoạn
      if (command === '/chunk_cancel') {
        await handleChunkUploadCancel(chatId, userId, env);
        return new Response('OK', { status: 200 });
      }
      
      if (command === '/start') {
        try {
          console.log("Bắt đầu xử lý lệnh /start");
          const result = await sendMessage(chatId, '🤖 Bot đã được kích hoạt!\n\nBạn chỉ cần gửi tệp để tự động tải lên, hỗ trợ hơn 400 định dạng như hình ảnh, video, âm thanh, tài liệu. Thêm mô tả văn bản khi gửi tệp để làm ghi chú, giúp bạn dễ dàng tìm kiếm sau này. Hỗ trợ tải lên tệp tối đa 20MB (giới hạn của Telegram Bot).\n\nCần tải lên tệp lớn? Hãy thử lệnh /chunk_upload để bắt đầu tải lên phân đoạn!', env);
          console.log("Phản hồi lệnh /start:", JSON.stringify(result).substring(0, 200));
          
          // Ghi lại việc sử dụng của người dùng, cập nhật danh sách người dùng
          await addUserToList(userId, username, env);
        } catch (error) {
          console.error("Gửi tin nhắn /start thất bại:", error);
        }
      } else if (command === '/help') {
        try {
          console.log("Bắt đầu xử lý lệnh /help");
          const result = await sendMessage(chatId, '📖 Hướng dẫn sử dụng:\n\n1. Gửi /start để kích hoạt bot (chỉ cần thực hiện lần đầu).\n2. Gửi trực tiếp hình ảnh, video, âm thanh, tài liệu hoặc các tệp khác, bot sẽ tự động xử lý tải lên.\n3. Thêm mô tả văn bản khi gửi tệp để làm ghi chú cho tệp, giúp tìm kiếm sau này thuận tiện hơn.\n4. Hỗ trợ tải lên tệp tối đa 20MB (giới hạn bởi Telegram Bot).\n5. Hỗ trợ hơn 400 định dạng tệp, bao gồm hình ảnh, video, âm thanh, tài liệu, tệp nén, tệp thực thi phổ biến, v.v.\n6. Sử dụng lệnh /formats để xem danh sách các loại định dạng tệp được hỗ trợ.\n7. Sử dụng lệnh /analytics để xem tất cả các phân tích thống kê (hỗ trợ nhiều tham số).\n8. Sử dụng lệnh /history để xem lịch sử tải lên của bạn.\n9. Sử dụng lệnh /chunk_upload để bắt đầu chế độ tải lên phân đoạn, vượt qua giới hạn 20MB.\n10. Bot này được phát triển bởi @uki0x', env);
          console.log("Phản hồi lệnh /help:", JSON.stringify(result).substring(0, 200));
        } catch (error) {
          console.error("Gửi tin nhắn /help thất bại:", error);
        }
      } else if (command === '/formats') {
        try {
          console.log("Bắt đầu xử lý lệnh /formats");
          const formatsMessage = `📋 Các loại định dạng tệp được hỗ trợ:\n\n` +
            `🖼️ Hình ảnh: jpg, png, gif, webp, svg, bmp, tiff, heic, raw...\n` +
            `🎬 Video: mp4, avi, mov, mkv, webm, flv, rmvb, m4v...\n` +
            `🎵 Âm thanh: mp3, wav, ogg, flac, aac, m4a, wma, opus...\n` +
            `📝 Tài liệu: pdf, doc(x), xls(x), ppt(x), txt, md, epub...\n` +
            `🗜️ Nén: zip, rar, 7z, tar, gz, xz, bz2...\n` +
            `⚙️ Thực thi: exe, msi, apk, ipa, deb, rpm, dmg...\n` +
            `🌐 Web/Code: html, css, js, ts, py, java, php, go...\n` +
            `🎨 3D/Thiết kế: obj, fbx, blend, stl, psd, ai, sketch...\n` +
            `📊 Dữ liệu/Khoa học: mat, hdf5, parquet, csv, json, xml...\n\n` +
            `Tổng cộng hỗ trợ hơn 400 định dạng tệp!`;
          const result = await sendMessage(chatId, formatsMessage, env);
          console.log("Phản hồi lệnh /formats:", JSON.stringify(result).substring(0, 200));
        } catch (error) {
          console.error("Gửi tin nhắn /formats thất bại:", error);
        }
      } else if (command === '/stats') {
        try {
          console.log("Bắt đầu xử lý lệnh /stats");
          const stats = await getUserStats(chatId, env);
          const statsMessage = formatStatsMessage(stats);
          const result = await sendMessage(chatId, statsMessage, env);
          console.log("Phản hồi lệnh /stats:", JSON.stringify(result).substring(0, 200));
        } catch (error) {
          console.error("Gửi tin nhắn /stats thất bại:", error);
        }
      } else if (command === '/storage') {
        try {
          console.log("Bắt đầu xử lý lệnh /storage");
          const stats = await getUserStats(chatId, env);
          const storageMessage = formatStorageMessage(stats);
          const result = await sendMessage(chatId, storageMessage, env);
          console.log("Phản hồi lệnh /storage:", JSON.stringify(result).substring(0, 200));
        } catch (error) {
          console.error("Gửi tin nhắn /storage thất bại:", error);
        }
      } else if (command === '/report') {
        try {
          console.log("Bắt đầu xử lý lệnh /report");
          const periodArg = text.split(' ')[1]?.toLowerCase();
          let period = 'monthly'; // Mặc định là báo cáo tháng
          
          if (periodArg === 'daily' || periodArg === 'day') {
            period = 'daily';
          } else if (periodArg === 'weekly' || periodArg === 'week') {
            period = 'weekly';
          }
          
          const report = await getUserReport(chatId, period, env);
          const reportMessage = formatReportMessage(report, period);
          const result = await sendMessage(chatId, reportMessage, env);
          console.log(`Phản hồi lệnh báo cáo ${period}:`, JSON.stringify(result).substring(0, 200));
        } catch (error) {
          console.error("Gửi tin nhắn /report thất bại:", error);
        }
      } else if (command === '/success_rate') {
        try {
          console.log("Bắt đầu xử lý lệnh /success_rate");
          const stats = await getUserStats(chatId, env);
          const successRateMessage = formatSuccessRateMessage(stats);
          const result = await sendMessage(chatId, successRateMessage, env);
          console.log("Phản hồi lệnh /success_rate:", JSON.stringify(result).substring(0, 200));
        } catch (error) {
          console.error("Gửi tin nhắn /success_rate thất bại:", error);
        }
      } else if (command === '/analytics' || command === '/analytics@' + env.BOT_USERNAME) {
        try {
          console.log("Bắt đầu xử lý lệnh /analytics");
          const args = text.split(' ')[1]?.toLowerCase();
          
          // Quyết định hiển thị loại thông tin thống kê nào dựa trên tham số
          if (args === 'storage') {
            // Hiển thị thống kê lưu trữ
            const stats = await getUserStats(chatId, env);
            const storageMessage = formatStorageMessage(stats);
            await sendMessage(chatId, storageMessage, env);
          } else if (args === 'report' || args === 'daily' || args === 'weekly' || args === 'monthly') {
            // Hiển thị báo cáo sử dụng
            let period = 'monthly'; // Mặc định là báo cáo tháng
            
            if (args === 'daily') {
              period = 'daily';
            } else if (args === 'weekly') {
              period = 'weekly';
            }
            
            const report = await getUserReport(chatId, period, env);
            const reportMessage = formatReportMessage(report, period);
            await sendMessage(chatId, reportMessage, env);
          } else if (args === 'success' || args === 'success_rate') {
            // Hiển thị tỷ lệ thành công
            const stats = await getUserStats(chatId, env);
            const successRateMessage = formatSuccessRateMessage(stats);
            await sendMessage(chatId, successRateMessage, env);
          } else {
            // Mặc định hiển thị thống kê tổng hợp
            const stats = await getUserStats(chatId, env);
            const statsMessage = formatStatsMessage(stats);
            await sendMessage(chatId, statsMessage, env);
          }
          
          console.log("Đã gửi phản hồi lệnh /analytics");
        } catch (error) {
          console.error("Gửi tin nhắn /analytics thất bại:", error);
          await sendMessage(chatId, `❌ Lấy thông tin thống kê thất bại: ${error.message}`, env);
        }
      } else if (command === '/history' || command === '/history@' + env.BOT_USERNAME) {
        try {
          console.log("Bắt đầu xử lý lệnh /history");
          // Phân tích tham số
          const args = text.split(' ');
          let page = 1;
          let fileType = null;
          let searchQuery = null;
          let descQuery = null; // Mới: Truy vấn dành riêng cho việc tìm kiếm ghi chú
          
          // Tìm từ khóa tìm kiếm
          if (text.includes('search:') || text.includes('搜索:')) {
            const searchMatch = text.match(/(search:|搜索:)\s*([^\s]+)/i);
            if (searchMatch && searchMatch[2]) {
              searchQuery = searchMatch[2].trim();
            }
          }
          
          // Tìm từ khóa tìm kiếm ghi chú
          if (text.includes('desc:') || text.includes('备注:')) {
            const descMatch = text.match(/(desc:|备注:)\s*([^\s]+)/i);
            if (descMatch && descMatch[2]) {
              descQuery = descMatch[2].trim();
            }
          }
          
          // Phân tích tham số số trang
          for (let i = 1; i < args.length; i++) {
            const arg = args[i].toLowerCase();
            
            // Nếu đã tìm thấy từ khóa tìm kiếm, bỏ qua xử lý tiếp theo
            if (searchQuery || descQuery) continue;
            
            if (arg.startsWith('p') || arg.startsWith('page')) {
              const pageNum = parseInt(arg.replace(/^p(age)?/, ''));
              if (!isNaN(pageNum) && pageNum > 0) {
                page = pageNum;
              }
            } else if (['image', 'video', 'audio', 'document', 'animation'].includes(arg)) {
              fileType = arg;
            } else if (arg.startsWith('search:') || arg.startsWith('搜索:')) {
              searchQuery = arg.split(':')[1];
            } else if (arg.startsWith('desc:') || arg.startsWith('备注:')) {
              descQuery = arg.split(':')[1];
            }
          }
          
          await handleHistoryCommand(chatId, page, fileType, searchQuery, descQuery, env);
        } catch (error) {
          console.error("Gửi tin nhắn /history thất bại:", error);
          await sendMessage(chatId, `❌ Lấy lịch sử tải lên thất bại: ${error.message}`, env);
        }
      } else {
        console.log("Lệnh không xác định:", command);
        try {
          await sendMessage(chatId, `Lệnh không xác định：${command}。Vui lòng sử dụng /start hoặc /help để xem hướng dẫn.`, env);
        } catch (error) {
          console.error("Gửi tin nhắn lệnh không xác định thất bại:", error);
        }
      }
      return new Response('OK', { status: 200 });
    }

    // Kiểm tra xem có đang ở chế độ tải lên phân đoạn không
    const isInChunkUploadMode = await isUserInChunkUploadMode(userId, env);
    if (isInChunkUploadMode) {
      // Xử lý các tin nhắn trong quá trình tải lên phân đoạn
      await handleChunkUploadMessage(message, chatId, userId, env);
      return new Response('OK', { status: 200 });
    }

    // Tự động xử lý hình ảnh
    if (message.photo && message.photo.length > 0) {
      try {
        console.log(`Bắt đầu xử lý hình ảnh, độ dài: ${message.photo.length}`);
        // Đảm bảo người dùng được thêm vào danh sách người dùng
        await addUserToList(userId, username, env);
        await handlePhoto(message, chatId, env);
      } catch (error) {
        console.error("Lỗi khi xử lý hình ảnh:", error);
        await sendMessage(chatId, `❌ Lỗi khi xử lý hình ảnh: ${error.message}`, env).catch(e => console.error("Gửi thông báo lỗi hình ảnh thất bại:", e));
      }
    }
    // Tự động xử lý video
    else if (message.video || (message.document &&
            (message.document.mime_type?.startsWith('video/') ||
             message.document.file_name?.match(/\.(mp4|avi|mov|wmv|flv|mkv|webm|m4v|3gp|mpeg|mpg|ts|rmvb|rm|asf|amv|mts|m2ts|vob|divx|ogm|ogv)$/i)))) {
      try {
        console.log(`Bắt đầu xử lý video, loại: ${message.video ? 'video' : 'document'}`);
        // Đảm bảo người dùng được thêm vào danh sách người dùng
        await addUserToList(userId, username, env);
        await handleVideo(message, chatId, !!message.document, env);
      } catch (error) {
        console.error('Lỗi khi xử lý video:', error);
        let errorDetails = '';
        if (error.message) {
          errorDetails = `\nChi tiết lỗi: ${error.message}`;
        }
        
        const errorMsg = `❌ Lỗi khi xử lý video.${errorDetails}\n\nGợi ý thử lại:\n1. Gửi lại video\n2. Nếu video lớn, hãy thử nén trước khi gửi\n3. Thử chuyển đổi video sang định dạng MP4`;
        if (messageId) {
          await editMessage(chatId, messageId, errorMsg, env);
        } else {
          await sendMessage(chatId, errorMsg, env);
        }
      }
    }
    // Tự động xử lý âm thanh
    else if (message.audio || (message.document &&
            (message.document.mime_type?.startsWith('audio/') ||
             message.document.file_name?.match(/\.(mp3|wav|ogg|flac|aac|m4a|wma|opus|mid|midi|ape|ra|amr|au|voc|ac3|dsf|dsd|dts|ast|aiff|aifc|spx|gsm|wv|tta|mpc|tak)$/i)))) {
      try {
        console.log(`Bắt đầu xử lý âm thanh, loại: ${message.audio ? 'audio' : 'document'}`);
        // Đảm bảo người dùng được thêm vào danh sách người dùng
        await addUserToList(userId, username, env);
        await handleAudio(message, chatId, !!message.document, env);
      } catch (error) {
        console.error('Lỗi khi xử lý âm thanh:', error);
        let errorDetails = '';
        if (error.message) {
          errorDetails = `\nChi tiết lỗi: ${error.message}`;
        }
        
        const errorMsg = `❌ Lỗi khi xử lý âm thanh.${errorDetails}\n\nGợi ý thử lại:\n1. Gửi lại âm thanh\n2. Thử chuyển đổi âm thanh sang định dạng MP3`;
        if (messageId) {
          await editMessage(chatId, messageId, errorMsg, env);
        } else {
          await sendMessage(chatId, errorMsg, env);
        }
      }
    }
    // Tự động xử lý ảnh động/GIF
    else if (message.animation || (message.document &&
            (message.document.mime_type?.includes('animation') ||
             message.document.file_name?.match(/\.(gif|webp|apng|flif|avif)$/i)))) {
      try {
        console.log(`Bắt đầu xử lý ảnh động, loại: ${message.animation ? 'animation' : 'document'}`);
        // Đảm bảo người dùng được thêm vào danh sách người dùng
        await addUserToList(userId, username, env);
        await handleAnimation(message, chatId, !!message.document, env);
      } catch (error) {
        console.error('Lỗi khi xử lý ảnh động:', error);
        let errorDetails = '';
        if (error.message) {
          errorDetails = `\nChi tiết lỗi: ${error.message}`;
        }
        
        const errorMsg = `❌ Lỗi khi xử lý ảnh động.${errorDetails}\n\nGợi ý thử lại:\n1. Gửi lại GIF\n2. Thử chuyển đổi ảnh động sang định dạng GIF chuẩn`;
        if (messageId) {
          await editMessage(chatId, messageId, errorMsg, env);
        } else {
          await sendMessage(chatId, errorMsg, env);
        }
      }
    }
    // Xử lý tất cả các loại tài liệu khác
    else if (message.document) {
      try {
        console.log(`Bắt đầu xử lý tài liệu, loại mime: ${message.document.mime_type || 'Không xác định'}`);
        // Đảm bảo người dùng được thêm vào danh sách người dùng
        await addUserToList(userId, username, env);
        await handleDocument(message, chatId, env);
      } catch (error) {
        console.error('Lỗi khi xử lý tệp:', error);
        let errorDetails = '';
        if (error.message) {
          errorDetails = `\nChi tiết lỗi: ${error.message}`;
        }
        
        const errorMsg = `❌ Lỗi khi xử lý tệp.${errorDetails}\n\nGợi ý thử lại:\n1. Gửi lại tệp\n2. Nếu tệp lớn, hãy thử nén trước khi gửi`;
        if (messageId) {
          await editMessage(chatId, messageId, errorMsg, env);
        } else {
          await sendMessage(chatId, errorMsg, env);
        }
      }
    } else {
      console.log("Nhận được loại tin nhắn không thể xử lý");
      await sendMessage(chatId, "⚠️ Không thể nhận diện loại tin nhắn này. Vui lòng gửi ảnh, video, âm thanh hoặc tệp tài liệu.", env);
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Lỗi khi xử lý yêu cầu:', error); // In lỗi trong nhật ký Worker
    // Tránh trả về chi tiết lỗi cho phía người dùng, nhưng có thể gửi tin nhắn lỗi chung khi cần thiết
    await sendMessage(env.ADMIN_CHAT_ID || chatId, `Lỗi nội bộ khi xử lý yêu cầu: ${error.message}`, env).catch(e => console.error("Gửi tin nhắn lỗi thất bại:", e)); // Cố gắng thông báo cho quản trị viên hoặc người dùng
    return new Response('Lỗi khi xử lý yêu cầu', { status: 500 });
  }
}

/**
 * Re-upload file lên CF-imgbed: tải binary từ Telegram về Worker rồi upload lại.
 * Chỉ dùng khi Copy Mode TẮT. Không có logic copy mode ở đây.
 */
async function uploadToImgBed(telegramFileUrl, fileName, mimeType, uploadFolder, adminToken, IMG_BED_URL, AUTH_CODE) {
  const uploadUrl = new URL(IMG_BED_URL);
  uploadUrl.searchParams.append('returnFormat', 'full');
  if (uploadFolder && uploadFolder !== '/') uploadUrl.searchParams.append('uploadFolder', uploadFolder);
  if (AUTH_CODE) uploadUrl.searchParams.append('authCode', AUTH_CODE);

  const authHeaders = {};
  if (adminToken) authHeaders['Authorization'] = `Bearer ${adminToken}`;
  else if (AUTH_CODE) authHeaders['Authorization'] = `Bearer ${AUTH_CODE}`;

  const tgResp = await fetch(telegramFileUrl);
  if (!tgResp.ok) throw new Error(`Tải file từ Telegram thất bại: ${tgResp.status}`);
  const buffer = await tgResp.arrayBuffer();
  const fileSize = buffer.byteLength;

  if (fileSize / (1024 * 1024) > 20) {
    const err = new Error('FILE_TOO_LARGE');
    err.fileSize = fileSize;
    throw err;
  }

  const formData = new FormData();
  formData.append('file', new File([buffer], fileName, { type: mimeType }));
  if (uploadFolder && uploadFolder !== '/') formData.append('uploadFolder', uploadFolder);

  console.log(`[ReUpload] ${fileName} (${formatFileSize(fileSize)}) → ${uploadUrl.toString()}`);
  const uploadResp = await fetch(uploadUrl.toString(), { method: 'POST', headers: authHeaders, body: formData });
  const responseText = await uploadResp.text();
  console.log(`[ReUpload] Status: ${uploadResp.status}, response:`, responseText.substring(0, 200));

  let uploadResult;
  try { uploadResult = JSON.parse(responseText); } catch(e) { uploadResult = responseText; }
  const extracted = extractUrlFromResult(uploadResult, IMG_BED_URL);
  return {
    url: extracted?.url || null,
    fileName: extracted?.fileName || fileName,
    fileSize: extracted?.fileSize || fileSize,
    rawResponse: responseText
  };
}

// Xử lý tải lên hình ảnh
async function handlePhoto(message, chatId, env) {
  const photo = message.photo[message.photo.length - 1];
  const fileId = photo.file_id;
  const photoDescription = message.caption || "";

  const IMG_BED_URL = env.IMG_BED_URL;
  const BOT_TOKEN = env.BOT_TOKEN;
  const AUTH_CODE = env.AUTH_CODE;

  const sendResult = await sendMessage(chatId, '🔄 Đang xử lý hình ảnh của bạn, vui lòng đợi...', env);
  const messageId = sendResult && sendResult.ok ? sendResult.result.message_id : null;

  const copyMode = await getCopyMode(env);

  // ── COPY MODE BẬT: copy trực tiếp sang kênh CF-imgbed, không cần getFile hay download ──
  if (copyMode) {
    try {
      const fileName = `image_${Date.now()}.jpg`;
      const result = await tryCopyMode(message.chat.id, message.message_id, fileName, 'image/jpeg', photoDescription, env);
      let msgText = `✅ Tải ảnh lên thành công!\n⚡ Copy Mode (Telegram copy → KV trực tiếp)\n\n📄 Tên tệp: ${result.fileName}\n`;
      if (photoDescription) msgText += `📝 Ghi chú: ${photoDescription}\n`;
      msgText += `📦 Dung lượng: ${formatFileSize(result.fileSize)}\n\n🔗 URL: ${result.url}`;
      if (messageId) await editMessage(chatId, messageId, msgText, env);
      else await sendMessage(chatId, msgText, env);
      await updateUserStats(chatId, { fileType: 'image', fileSize: result.fileSize, success: true, fileName: result.fileName, url: result.url, description: photoDescription }, env);
    } catch (err) {
      console.error('[handlePhoto] Copy mode lỗi:', err.message);
      const msg = `❌ Copy Mode thất bại:\n${err.message}\n\n⚙️ Kiểm tra /admin cfstatus`;
      if (messageId) await editMessage(chatId, messageId, msg, env);
      else await sendMessage(chatId, msg, env);
      await updateUserStats(chatId, { fileType: 'image', fileSize: 0, success: false }, env);
    }
    return;
  }

  // ── RE-UPLOAD MODE: cần getFile để download binary về Worker (logic gốc) ──
  const fileInfo = await getFile(fileId, env);
  if (!fileInfo || !fileInfo.ok) {
    const errorMsg = '❌ Không thể lấy thông tin hình ảnh, vui lòng thử lại sau.';
    if (messageId) await editMessage(chatId, messageId, errorMsg, env);
    else await sendMessage(chatId, errorMsg, env);
    return;
  }

  const filePath = fileInfo.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const fileName = `image_${Date.now()}.jpg`;

  try {
    const imgResponse = await fetch(fileUrl);
    const imgBuffer = await imgResponse.arrayBuffer();
    const fileSize = imgBuffer.byteLength;

    if (fileSize / (1024 * 1024) > 20) {
      const warningMsg = `⚠️ Hình ảnh quá lớn (${formatFileSize(fileSize)}), vượt quá giới hạn 20MB, không thể tải lên.\n\n💡 Cần tải lên file lớn? Hãy thử /chunk_upload`;
      if (messageId) await editMessage(chatId, messageId, warningMsg, env);
      else await sendMessage(chatId, warningMsg, env);
      return;
    }

    const formData = new FormData();
    formData.append('file', new File([imgBuffer], fileName, { type: 'image/jpeg' }));

    const uploadUrl = new URL(IMG_BED_URL);
    uploadUrl.searchParams.append('returnFormat', 'full');

    // Gắn thư mục tải lên nếu có cấu hình
    const uploadFolder = await getUploadFolder(env);
    if (uploadFolder && uploadFolder !== '/') {
      uploadUrl.searchParams.append('uploadFolder', uploadFolder);
      formData.append('uploadFolder', uploadFolder);
    }

    const headers = {};
    const adminToken = await getImgBedAdminToken(env);
    if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
    else if (AUTH_CODE) headers['Authorization'] = `Bearer ${AUTH_CODE}`;
    if (AUTH_CODE) uploadUrl.searchParams.append('authCode', AUTH_CODE);

    console.log(`URL yêu cầu tải ảnh lên: ${uploadUrl.toString()}`);
    const uploadResponse = await fetch(uploadUrl, { method: 'POST', headers, body: formData });
    const responseText = await uploadResponse.text();
    console.log('Phản hồi gốc khi tải ảnh lên:', responseText);

    let uploadResult;
    try { uploadResult = JSON.parse(responseText); } catch(e) { uploadResult = responseText; }

    const extractedResult = extractUrlFromResult(uploadResult, IMG_BED_URL);
    const imgUrl = extractedResult.url;
    const actualFileName = extractedResult.fileName || fileName;
    const actualFileSize = extractedResult.fileSize || fileSize;

    if (imgUrl) {
      let msgText = `✅ Tải ảnh lên thành công!\n\n📄 Tên tệp: ${actualFileName}\n`;
      // Nếu có mô tả ảnh, thêm thông tin ghi chú
      if (photoDescription) msgText += `📝 Ghi chú: ${photoDescription}\n`;
      msgText += `📦 Dung lượng tệp: ${formatFileSize(actualFileSize)}\n\n🔗 URL: ${imgUrl}`;
      if (messageId) await editMessage(chatId, messageId, msgText, env);
      else await sendMessage(chatId, msgText, env);
      // Cập nhật thống kê người dùng, thêm trường ghi chú
      await updateUserStats(chatId, { fileType: 'image', fileSize: actualFileSize, success: true, fileName: actualFileName, url: imgUrl, description: photoDescription }, env);
    } else {
      const errorMsg = `❌ Không thể phân tích kết quả tải lên, phản hồi gốc:\n${responseText.substring(0, 200)}...`;
      if (messageId) await editMessage(chatId, messageId, errorMsg, env);
      else await sendMessage(chatId, errorMsg, env);
      await updateUserStats(chatId, { fileType: 'image', fileSize: fileSize, success: false }, env);
    }
  } catch (error) {
    console.error('Lỗi khi xử lý tải ảnh lên:', error);
    const errorMsg = `❌ Lỗi khi xử lý tải ảnh lên: ${error.message}\n\nCó thể do ảnh quá lớn hoặc định dạng không được hỗ trợ.`;
    if (messageId) await editMessage(chatId, messageId, errorMsg, env);
    else await sendMessage(chatId, errorMsg, env);
  }
}

// Xử lý tải lên video
async function handleVideo(message, chatId, isDocument = false, env) {
  const fileId = isDocument ? message.document.file_id : message.video.file_id;
  const baseFileName = isDocument ? (message.document.file_name || `video_${Date.now()}.mp4`) : `video_${Date.now()}.mp4`;
  // Lấy mô tả video của người dùng để làm ghi chú
  const videoDescription = message.caption || "";

  const IMG_BED_URL = env.IMG_BED_URL;
  const BOT_TOKEN = env.BOT_TOKEN;
  const AUTH_CODE = env.AUTH_CODE;

  const sendResult = await sendMessage(chatId, `🔄 Đang xử lý video "${baseFileName}" của bạn, vui lòng đợi...`, env);
  const messageId = sendResult && sendResult.ok ? sendResult.result.message_id : null;

  const copyMode = await getCopyMode(env);

  // ── COPY MODE BẬT: copy trực tiếp, không cần getFile hay download (hỗ trợ file >20MB) ──
  if (copyMode) {
    // Lấy mimeType trực tiếp từ message (không cần gọi getFile API)
    const mimeType = isDocument
      ? (message.document.mime_type || 'video/mp4')
      : (message.video?.mime_type || 'video/mp4');
    const copyFileName = isDocument
      ? (message.document.file_name || `video_${Date.now()}.mp4`)
      : `video_${Date.now()}.mp4`;
    console.log(`[handleVideo] Copy mode bật. mimeType=${mimeType}, fileName=${copyFileName}`);
    try {
      const result = await tryCopyMode(message.chat.id, message.message_id, copyFileName, mimeType, videoDescription, env);
      let msgText = `✅ Tải video lên thành công!\n⚡ Copy Mode (Telegram copy → KV trực tiếp)\n\n📄 Tên tệp: ${result.fileName}\n`;
      if (videoDescription) msgText += `📝 Ghi chú: ${videoDescription}\n`;
      msgText += `📦 Dung lượng: ${formatFileSize(result.fileSize)}\n\n🔗 URL: ${result.url}`;
      if (messageId) await editMessage(chatId, messageId, msgText, env);
      else await sendMessage(chatId, msgText, env);
      await updateUserStats(chatId, { fileType: 'video', fileSize: result.fileSize, success: true, fileName: result.fileName, url: result.url, description: videoDescription }, env);
    } catch (err) {
      console.error('[handleVideo] Copy mode lỗi:', err.message);
      const msg = `❌ Copy Mode thất bại:\n${err.message}\n\n⚙️ Kiểm tra /admin cfstatus`;
      if (messageId) await editMessage(chatId, messageId, msg, env);
      else await sendMessage(chatId, msg, env);
      await updateUserStats(chatId, { fileType: 'video', fileSize: 0, success: false }, env);
    }
    return;
  }

  // ── RE-UPLOAD MODE: cần getFile để download binary về Worker (chỉ hỗ trợ file ≤20MB) ──
  const fileInfo = await getFile(fileId, env);
  if (!fileInfo || !fileInfo.ok) {
    const errorMsg = `❌ Không thể lấy thông tin video.\n(File >20MB không thể upload theo cách này)\n\n💡 Dùng /chunk_upload cho file lớn.`;
    if (messageId) await editMessage(chatId, messageId, errorMsg, env);
    else await sendMessage(chatId, errorMsg, env);
    return;
  }

  const filePath = fileInfo.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const fileName = baseFileName;
  const mimeType = isDocument ? message.document.mime_type || 'video/mp4' : 'video/mp4';

  try {
    const videoResponse = await fetch(fileUrl);
    if (!videoResponse.ok) throw new Error(`Lấy video thất bại: ${videoResponse.status}`);

    const videoBuffer = await videoResponse.arrayBuffer();
    const videoSize = videoBuffer.byteLength;
    const fileSizeFormatted = formatFileSize(videoSize);

    if (videoSize / (1024 * 1024) > 20) {
      const warningMsg = `⚠️ Video quá lớn (${fileSizeFormatted}), vượt quá giới hạn 20MB, không thể tải lên.\n\n💡 Cần tải lên file lớn? Hãy thử /chunk_upload`;
      if (messageId) await editMessage(chatId, messageId, warningMsg, env);
      else await sendMessage(chatId, warningMsg, env);
      return;
    }

    const formData = new FormData();
    formData.append('file', new File([videoBuffer], fileName, { type: mimeType }));

    const uploadUrl = new URL(IMG_BED_URL);
    uploadUrl.searchParams.append('returnFormat', 'full');

    // Gắn thư mục tải lên nếu có cấu hình
    const uploadFolder = await getUploadFolder(env);
    if (uploadFolder && uploadFolder !== '/') {
      uploadUrl.searchParams.append('uploadFolder', uploadFolder);
      formData.append('uploadFolder', uploadFolder);
    }

    if (AUTH_CODE) uploadUrl.searchParams.append('authCode', AUTH_CODE);

    console.log(`URL yêu cầu tải video lên: ${uploadUrl.toString()}`);
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: AUTH_CODE ? { 'Authorization': `Bearer ${AUTH_CODE}` } : {},
      body: formData
    });

    const responseText = await uploadResponse.text();
    console.log('Phản hồi gốc khi tải video lên:', responseText);

    let uploadResult;
    try { uploadResult = JSON.parse(responseText); } catch(e) { uploadResult = responseText; }

    const extractedResult = extractUrlFromResult(uploadResult, IMG_BED_URL);
    const videoUrl = extractedResult.url;
    const actualFileName = extractedResult.fileName || fileName;
    const actualFileSize = extractedResult.fileSize || videoSize;

    if (videoUrl) {
      let msgText = `✅ Tải video lên thành công!\n\n📄 Tên tệp: ${actualFileName}\n`;
      // Nếu có mô tả video, thêm thông tin ghi chú
      if (videoDescription) msgText += `📝 Ghi chú: ${videoDescription}\n`;
      msgText += `📦 Dung lượng tệp: ${formatFileSize(actualFileSize)}\n\n🔗 URL: ${videoUrl}`;
      if (messageId) await editMessage(chatId, messageId, msgText, env);
      else await sendMessage(chatId, msgText, env);
      // Cập nhật thống kê người dùng, thêm trường ghi chú
      await updateUserStats(chatId, { fileType: 'video', fileSize: actualFileSize, success: true, fileName: actualFileName, url: videoUrl, description: videoDescription }, env);
    } else {
      const errorMsg = `⚠️ Không thể lấy được liên kết video từ kho ảnh. Vui lòng thử lại sau.`;
      if (messageId) await editMessage(chatId, messageId, errorMsg, env);
      else await sendMessage(chatId, errorMsg, env);
      await updateUserStats(chatId, { fileType: 'video', fileSize: videoSize, success: false }, env);
    }
  } catch (error) {
    console.error('Lỗi khi xử lý video:', error);
    const errorMsg = `❌ Lỗi khi xử lý video: ${error.message}`;
    if (messageId) await editMessage(chatId, messageId, errorMsg, env);
    else await sendMessage(chatId, errorMsg, env);
  }
}

// Xử lý tải lên âm thanh
async function handleAudio(message, chatId, isDocument = false, env) {
  const fileId = isDocument ? message.document.file_id : message.audio.file_id;
  const fileName = isDocument 
    ? message.document.file_name 
    : (message.audio.title || message.audio.file_name || `audio_${Date.now()}.mp3`);
  // Lấy mô tả âm thanh của người dùng để làm ghi chú
  const audioDescription = message.caption || "";

  // Lấy cấu hình từ env
  const IMG_BED_URL = env.IMG_BED_URL;
  const BOT_TOKEN = env.BOT_TOKEN;
  const AUTH_CODE = env.AUTH_CODE;

  // Gửi tin nhắn đang xử lý và lấy ID tin nhắn để cập nhật sau
  const sendResult = await sendMessage(chatId, `🔄 Đang xử lý âm thanh "${fileName}" của bạn, vui lòng đợi...`, env);
  const messageId = sendResult && sendResult.ok ? sendResult.result.message_id : null;

  const fileInfo = await getFile(fileId, env);

  if (fileInfo && fileInfo.ok) {
    const filePath = fileInfo.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

    try {
      const audioResponse = await fetch(fileUrl);
      if (!audioResponse.ok) throw new Error(`Lấy âm thanh thất bại: ${audioResponse.status}`);

      const audioBuffer = await audioResponse.arrayBuffer();
      const audioSize = audioBuffer.byteLength;
      const fileSizeFormatted = formatFileSize(audioSize);
      
      if (audioSize / (1024 * 1024) > 20) { // 20MB
        const warningMsg = `⚠️ Âm thanh quá lớn (${fileSizeFormatted}), vượt quá giới hạn 20MB, không thể tải lên.`;
        if (messageId) {
          await editMessage(chatId, messageId, warningMsg, env);
        } else {
          await sendMessage(chatId, warningMsg, env);
        }
        return;
      }

      const formData = new FormData();
      const mimeType = isDocument 
        ? message.document.mime_type || 'audio/mpeg' 
        : (message.audio.mime_type || 'audio/mpeg');
      formData.append('file', new File([audioBuffer], fileName, { type: mimeType }));

      const uploadUrl = new URL(IMG_BED_URL);
      uploadUrl.searchParams.append('returnFormat', 'full');

      // Gắn thư mục tải lên nếu có cấu hình
      const uploadFolder = await getUploadFolder(env);
      if (uploadFolder && uploadFolder !== '/') {
        uploadUrl.searchParams.append('uploadFolder', uploadFolder);
        formData.append('uploadFolder', uploadFolder);
      }

      if (AUTH_CODE) {
        uploadUrl.searchParams.append('authCode', AUTH_CODE);
      }

      console.log(`URL yêu cầu tải âm thanh lên: ${uploadUrl.toString()}`);

      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: AUTH_CODE ? { 'Authorization': `Bearer ${AUTH_CODE}` } : {},
        body: formData
      });

      const responseText = await uploadResponse.text();
      console.log('Phản hồi gốc khi tải âm thanh lên:', responseText);

      let uploadResult;
      try {
        uploadResult = JSON.parse(responseText);
      } catch (e) {
        uploadResult = responseText;
      }

      const extractedResult = extractUrlFromResult(uploadResult, IMG_BED_URL);
      const audioUrl = extractedResult.url;
      // Sử dụng tên tệp đã trích xuất hoặc giá trị mặc định
      const actualFileName = extractedResult.fileName || fileName;
      // Sử dụng kích thước tệp đã tải lên, thay vì từ phản hồi (nếu có trong phản hồi, nó sẽ được trích xuất trong extractUrlFromResult)
      const actualFileSize = extractedResult.fileSize || audioSize;

      if (audioUrl) {
        let msgText = `✅ Tải âm thanh lên thành công!\n\n` +
                     `📄 Tên tệp: ${actualFileName}\n`;
        
        // Nếu có mô tả âm thanh, thêm thông tin ghi chú
        if (audioDescription) {
          msgText += `📝 Ghi chú: ${audioDescription}\n`;
        }
        
        msgText += `📦 Dung lượng tệp: ${formatFileSize(actualFileSize)}\n\n` +
                  `🔗 URL: ${audioUrl}`;
        
        // Cập nhật tin nhắn trước đó thay vì gửi tin nhắn mới
        if (messageId) {
          await editMessage(chatId, messageId, msgText, env);
        } else {
          await sendMessage(chatId, msgText, env);
        }
        
        // Cập nhật thống kê người dùng, thêm trường ghi chú
        await updateUserStats(chatId, {
          fileType: 'audio',
          fileSize: actualFileSize,
          success: true,
          fileName: actualFileName,
          url: audioUrl,
          description: audioDescription
        }, env);
      } else {
        const errorMsg = `⚠️ Không thể lấy được liên kết âm thanh từ kho ảnh. Phản hồi gốc (200 ký tự đầu):\n${responseText.substring(0, 200)}... \n\nHoặc thử liên kết tạm thời của Telegram (có hiệu lực hạn chế):\n${fileUrl}`;
        if (messageId) {
          await editMessage(chatId, messageId, errorMsg, env);
        } else {
          await sendMessage(chatId, errorMsg, env);
        }
        
        // Cập nhật thống kê thất bại
        await updateUserStats(chatId, {
          fileType: 'audio',
          fileSize: audioSize,
          success: false
        }, env);
      }
    } catch (error) {
      console.error('Lỗi khi xử lý âm thanh:', error);
      let errorDetails = '';
      if (error.message) {
        errorDetails = `\nChi tiết lỗi: ${error.message}`;
      }
      
      const errorMsg = `❌ Lỗi khi xử lý âm thanh.${errorDetails}\n\nGợi ý thử lại:\n1. Gửi lại âm thanh\n2. Thử chuyển đổi âm thanh sang định dạng MP3`;
      if (messageId) {
        await editMessage(chatId, messageId, errorMsg, env);
      } else {
        await sendMessage(chatId, errorMsg, env);
      }
    }
  } else {
    let errorDetails = '';
    if (fileInfo.error) {
      errorDetails = `\nChi tiết lỗi: ${fileInfo.error}`;
      console.error(`Lấy thông tin tệp âm thanh thất bại: ${fileInfo.error}`);
    }
    
    const errorMsg = `❌ Không thể lấy thông tin âm thanh, vui lòng thử lại sau.${errorDetails}\n\nGợi ý thử lại:\n1. Gửi lại âm thanh\n2. Thử chuyển đổi âm thanh sang định dạng MP3`;
    if (messageId) {
      await editMessage(chatId, messageId, errorMsg, env);
    } else {
      await sendMessage(chatId, errorMsg, env);
    }
  }
}

// Xử lý tải lên ảnh động/GIF
async function handleAnimation(message, chatId, isDocument = false, env) {
  const fileId = isDocument ? message.document.file_id : message.animation.file_id;
  const fileName = isDocument 
    ? message.document.file_name 
    : (message.animation.file_name || `animation_${Date.now()}.gif`);
  // Lấy mô tả ảnh động của người dùng để làm ghi chú
  const animDescription = message.caption || "";

  // Lấy cấu hình từ env
  const IMG_BED_URL = env.IMG_BED_URL;
  const BOT_TOKEN = env.BOT_TOKEN;
  const AUTH_CODE = env.AUTH_CODE;

  // Gửi tin nhắn đang xử lý và lấy ID tin nhắn để cập nhật sau
  const sendResult = await sendMessage(chatId, `🔄 Đang xử lý ảnh động/GIF "${fileName}" của bạn, vui lòng đợi...`, env);
  const messageId = sendResult && sendResult.ok ? sendResult.result.message_id : null;

  const fileInfo = await getFile(fileId, env);

  if (fileInfo && fileInfo.ok) {
    const filePath = fileInfo.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

    try {
      const animResponse = await fetch(fileUrl);
      if (!animResponse.ok) throw new Error(`Lấy ảnh động thất bại: ${animResponse.status}`);

      const animBuffer = await animResponse.arrayBuffer();
      const animSize = animBuffer.byteLength;
      const fileSizeFormatted = formatFileSize(animSize);
      
      if (animSize / (1024 * 1024) > 20) { // 20MB
        const warningMsg = `⚠️ Ảnh động quá lớn (${fileSizeFormatted}), vượt quá giới hạn 20MB, không thể tải lên.`;
        if (messageId) {
          await editMessage(chatId, messageId, warningMsg, env);
        } else {
          await sendMessage(chatId, warningMsg, env);
        }
        return;
      }

      const formData = new FormData();
      const mimeType = isDocument 
        ? message.document.mime_type || 'image/gif' 
        : (message.animation.mime_type || 'image/gif');
      formData.append('file', new File([animBuffer], fileName, { type: mimeType }));

      const uploadUrl = new URL(IMG_BED_URL);
      uploadUrl.searchParams.append('returnFormat', 'full');

      // Gắn thư mục tải lên nếu có cấu hình
      const uploadFolder = await getUploadFolder(env);
      if (uploadFolder && uploadFolder !== '/') {
        uploadUrl.searchParams.append('uploadFolder', uploadFolder);
        formData.append('uploadFolder', uploadFolder);
      }

      if (AUTH_CODE) {
        uploadUrl.searchParams.append('authCode', AUTH_CODE);
      }

      console.log(`URL yêu cầu tải ảnh động lên: ${uploadUrl.toString()}`);

      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: AUTH_CODE ? { 'Authorization': `Bearer ${AUTH_CODE}` } : {},
        body: formData
      });

      const responseText = await uploadResponse.text();
      console.log('Phản hồi gốc khi tải ảnh động lên:', responseText);

      let uploadResult;
      try {
        uploadResult = JSON.parse(responseText);
      } catch (e) {
        uploadResult = responseText;
      }

      const extractedResult = extractUrlFromResult(uploadResult, IMG_BED_URL);
      const animUrl = extractedResult.url;
      // Sử dụng tên tệp đã trích xuất hoặc giá trị mặc định
      const actualFileName = extractedResult.fileName || fileName;
      // Sử dụng kích thước tệp đã tải lên, thay vì từ phản hồi (nếu có trong phản hồi, nó sẽ được trích xuất trong extractUrlFromResult)
      const actualFileSize = extractedResult.fileSize || animSize;

      if (animUrl) {
        let msgText = `✅ Tải ảnh động/GIF thành công!\n\n` +
                     `📄 Tên tệp: ${actualFileName}\n`;
        
        // Nếu có mô tả ảnh động, thêm thông tin ghi chú
        if (animDescription) {
          msgText += `📝 Ghi chú: ${animDescription}\n`;
        }
        
        msgText += `📦 Dung lượng tệp: ${formatFileSize(actualFileSize)}\n\n` +
                  `🔗 URL: ${animUrl}`;
        
        // Cập nhật tin nhắn trước đó thay vì gửi tin nhắn mới
        if (messageId) {
          await editMessage(chatId, messageId, msgText, env);
        } else {
          await sendMessage(chatId, msgText, env);
        }
        
        // Cập nhật thống kê người dùng, thêm trường ghi chú
        await updateUserStats(chatId, {
          fileType: 'animation',
          fileSize: actualFileSize,
          success: true,
          fileName: actualFileName,
          url: animUrl,
          description: animDescription
        }, env);
      } else {
        const errorMsg = `⚠️ Không thể lấy được liên kết ảnh động từ kho ảnh. Phản hồi gốc (200 ký tự đầu):\n${responseText.substring(0, 200)}... \n\nHoặc thử liên kết tạm thời của Telegram (có hiệu lực hạn chế):\n${fileUrl}`;
        if (messageId) {
          await editMessage(chatId, messageId, errorMsg, env);
        } else {
          await sendMessage(chatId, errorMsg, env);
        }
        
        // Cập nhật thống kê thất bại
        await updateUserStats(chatId, {
          fileType: 'animation',
          fileSize: animSize,
          success: false
        }, env);
      }
    } catch (error) {
      console.error('Lỗi khi xử lý ảnh động:', error);
      let errorDetails = '';
      if (error.message) {
        errorDetails = `\nChi tiết lỗi: ${error.message}`;
      }
      
      const errorMsg = `❌ Lỗi khi xử lý ảnh động.${errorDetails}\n\nGợi ý thử lại:\n1. Gửi lại GIF\n2. Thử chuyển đổi ảnh động sang định dạng GIF chuẩn`;
      if (messageId) {
        await editMessage(chatId, messageId, errorMsg, env);
      } else {
        await sendMessage(chatId, errorMsg, env);
      }
    }
  } else {
    let errorDetails = '';
    if (fileInfo.error) {
      errorDetails = `\nChi tiết lỗi: ${fileInfo.error}`;
      console.error(`Lấy thông tin tệp ảnh động thất bại: ${fileInfo.error}`);
    }
    
    const errorMsg = `❌ Không thể lấy thông tin ảnh động, vui lòng thử lại sau.${errorDetails}\n\nGợi ý thử lại:\n1. Gửi lại GIF\n2. Thử chuyển đổi ảnh động sang định dạng GIF chuẩn`;
    if (messageId) {
      await editMessage(chatId, messageId, errorMsg, env);
    } else {
      await sendMessage(chatId, errorMsg, env);
    }
  }
}

// Xử lý tải lên tài liệu (xử lý tệp chung)
async function handleDocument(message, chatId, env) {
  const fileId = message.document.file_id;
  const fileName = message.document.file_name || `file_${Date.now()}`;
  const mimeType = message.document.mime_type || 'application/octet-stream';
  // Lấy mô tả tệp của người dùng để làm ghi chú
  const fileDescription = message.caption || "";

  // Kiểm tra xem phần mở rộng tệp có được hỗ trợ không
  const fileExt = fileName.split('.').pop().toLowerCase();
  const isSupported = isExtValid(fileExt);
  
  // Lấy cấu hình từ env
  const IMG_BED_URL = env.IMG_BED_URL;
  const BOT_TOKEN = env.BOT_TOKEN;
  const AUTH_CODE = env.AUTH_CODE;

  // Lấy biểu tượng loại tệp
  const fileIcon = getFileIcon(fileName, mimeType);
  
  // Gửi tin nhắn đang xử lý và lấy ID tin nhắn để cập nhật sau
  const sendResult = await sendMessage(chatId, `${fileIcon} Đang xử lý tệp "${fileName}" của bạn${isSupported ? '' : ' (Phần mở rộng không được hỗ trợ, nhưng vẫn sẽ thử tải lên)'}, vui lòng đợi...`, env);
  const messageId = sendResult && sendResult.ok ? sendResult.result.message_id : null;

  const fileInfo = await getFile(fileId, env);

  if (fileInfo && fileInfo.ok) {
    const filePath = fileInfo.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

    try {
      const fileResponse = await fetch(fileUrl);
      if (!fileResponse.ok) throw new Error(`Lấy tệp thất bại: ${fileResponse.status}`);

      const fileBuffer = await fileResponse.arrayBuffer();
      const fileSize = fileBuffer.byteLength;
      const fileSizeFormatted = formatFileSize(fileSize);

      if (fileSize / (1024 * 1024) > 20) { // 20MB
        const warningMsg = `⚠️ Tệp quá lớn (${fileSizeFormatted}), vượt quá giới hạn 20MB, không thể tải lên.`;
        if (messageId) {
          await editMessage(chatId, messageId, warningMsg, env);
        } else {
          await sendMessage(chatId, warningMsg, env);
        }
        return;
      }

      const formData = new FormData();
      
      // Sửa lỗi tải lên tệp exe: Đảm bảo tên tệp giữ nguyên, không thay đổi phần mở rộng
      let safeFileName = fileName;
      
      // Đảm bảo MIME type chính xác
      let safeMimeType = mimeType;
      // Thiết lập MIME type chính xác dựa trên phần mở rộng tệp
      if (fileExt) {
        // Tệp thực thi ứng dụng
        if (['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'snap', 'flatpak', 'appimage'].includes(fileExt)) {
          safeMimeType = 'application/octet-stream';
        }
        // Ứng dụng di động
        else if (['apk', 'ipa'].includes(fileExt)) {
          safeMimeType = 'application/vnd.android.package-archive';
        }
        // Tệp nén
        else if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'tbz2', 'txz'].includes(fileExt)) {
          safeMimeType = fileExt === 'zip' ? 'application/zip' : 'application/x-compressed';
        }
        // Ảnh đĩa
        else if (['iso', 'img', 'vdi', 'vmdk', 'vhd', 'vhdx', 'ova', 'ovf'].includes(fileExt)) {
          safeMimeType = 'application/octet-stream';
        }
      }
      
      formData.append('file', new File([fileBuffer], safeFileName, { type: safeMimeType }));

      const uploadUrl = new URL(IMG_BED_URL);
      uploadUrl.searchParams.append('returnFormat', 'full');

      // Gắn thư mục tải lên nếu có cấu hình
      const uploadFolder = await getUploadFolder(env);
      if (uploadFolder && uploadFolder !== '/') {
        uploadUrl.searchParams.append('uploadFolder', uploadFolder);
        formData.append('uploadFolder', uploadFolder);
      }

      if (AUTH_CODE) {
        uploadUrl.searchParams.append('authCode', AUTH_CODE);
      }

      console.log(`URL yêu cầu tải tệp lên: ${uploadUrl.toString()}`);

      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: AUTH_CODE ? { 'Authorization': `Bearer ${AUTH_CODE}` } : {},
        body: formData
      });

      const responseText = await uploadResponse.text();
      console.log('Phản hồi gốc khi tải tệp lên:', responseText);

      let uploadResult;
      try {
        uploadResult = JSON.parse(responseText);
      } catch (e) {
        uploadResult = responseText;
      }

      const extractedResult = extractUrlFromResult(uploadResult, IMG_BED_URL);
      const fileUrl2 = extractedResult.url;
      // Sử dụng tên tệp đã trích xuất hoặc giá trị mặc định
      const actualFileName = extractedResult.fileName || safeFileName;
      // Sử dụng kích thước tệp đã tải lên, thay vì từ phản hồi (nếu có trong phản hồi, nó sẽ được trích xuất trong extractUrlFromResult)
      const actualFileSize = extractedResult.fileSize || fileSize;

      if (fileUrl2) {
        let msgText = `✅ Tải tệp lên thành công!\n\n` +
                       `📄 Tên tệp: ${actualFileName}\n`;
        
        // Nếu có mô tả tệp, thêm thông tin ghi chú
        if (fileDescription) {
          msgText += `📝 Ghi chú: ${fileDescription}\n`;
        }
        
        msgText += `📦 Dung lượng tệp: ${formatFileSize(actualFileSize)}\n\n` +
                   `🔗 URL: ${fileUrl2}`;
        
        // Cập nhật tin nhắn trước đó thay vì gửi tin nhắn mới
        if (messageId) {
          await editMessage(chatId, messageId, msgText, env);
        } else {
          await sendMessage(chatId, msgText, env);
        }
        
        // Cập nhật thống kê người dùng, thêm thông tin ghi chú
        await updateUserStats(chatId, {
          fileType: 'document',
          fileSize: actualFileSize,
          success: true,
          fileName: actualFileName,
          url: fileUrl2,
          description: fileDescription // Thêm trường ghi chú
        }, env);
      } else {
        const errorMsg = `⚠️ Không thể lấy được liên kết tệp từ kho ảnh. Phản hồi gốc (200 ký tự đầu):\n${responseText.substring(0, 200)}... \n\nHoặc thử liên kết tạm thời của Telegram (có hiệu lực hạn chế):\n${fileUrl}`;
        if (messageId) {
          await editMessage(chatId, messageId, errorMsg, env);
        } else {
          await sendMessage(chatId, errorMsg, env);
        }
        
        // Cập nhật thống kê thất bại
        await updateUserStats(chatId, {
          fileType: 'document',
          fileSize: fileSize,
          success: false
        }, env);
      }
    } catch (error) {
      console.error('Lỗi khi xử lý tệp:', error);
      let errorDetails = '';
      if (error.message) {
        errorDetails = `\nChi tiết lỗi: ${error.message}`;
      }
      
      const errorMsg = `❌ Lỗi khi xử lý tệp.${errorDetails}\n\nGợi ý thử lại:\n1. Gửi lại tệp\n2. Nếu tệp lớn, hãy thử nén trước khi gửi`;
      if (messageId) {
        await editMessage(chatId, messageId, errorMsg, env);
      } else {
        await sendMessage(chatId, errorMsg, env);
      }
    }
  } else {
    let errorDetails = '';
    if (fileInfo.error) {
      errorDetails = `\nChi tiết lỗi: ${fileInfo.error}`;
      console.error(`Lấy thông tin tệp tài liệu thất bại: ${fileInfo.error}`);
    }
    
    const errorMsg = `❌ Không thể lấy thông tin tệp, vui lòng thử lại sau.${errorDetails}\n\nGợi ý thử lại:\n1. Gửi lại tệp\n2. Nếu tệp lớn, hãy thử nén trước khi gửi`;
    if (messageId) {
      await editMessage(chatId, messageId, errorMsg, env);
    } else {
      await sendMessage(chatId, errorMsg, env);
    }
  }
}

// Hàm bổ trợ: Trích xuất URL từ kết quả trả về của kho ảnh, nhận URL cơ sở
function extractUrlFromResult(result, imgBedUrl) {
  let url = '';
  let fileName = '';
  let fileSize = 0;
  
  // Thử lấy origin từ IMG_BED_URL truyền vào
  let baseUrl = 'https://your.default.domain'; // Cung cấp một URL cơ sở dự phòng
  try {
    if (imgBedUrl && (imgBedUrl.startsWith('https://') || imgBedUrl.startsWith('http://'))) {
      baseUrl = new URL(imgBedUrl).origin;
    }
  } catch (e) {
    console.error("Không thể phân tích IMG_BED_URL:", imgBedUrl, e);
  }

  console.log("Trích xuất URL, loại kết quả:", typeof result, "Giá trị:", JSON.stringify(result).substring(0, 200));

  // Xử lý các phản hồi lỗi có thể xảy ra
  if (typeof result === 'string' && result.includes("The string did not match the expected pattern")) {
    console.error("Gặp lỗi khớp mẫu, có thể do phần mở rộng tệp");
    // Thử trích xuất URL có thể có từ phản hồi lỗi
    const urlMatch = result.match(/(https?:\/\/[^\s"]+)/);
    if (urlMatch) {
      return { url: urlMatch[0], fileName: '', fileSize: 0 };
    }
  }

  // Ưu tiên xử lý định dạng phản hồi như [{"src": "/file/path.jpg"}]
  if (Array.isArray(result) && result.length > 0) {
    const item = result[0];
    if (item.url) {
      url = item.url;
      fileName = item.fileName || extractFileName(url);
      fileSize = item.fileSize || 0;
    } else if (item.src) {
      // Xử lý đặc biệt cho các đường dẫn bắt đầu bằng /file/
      if (item.src.startsWith('/file/')) {
        url = `${baseUrl}${item.src}`;
        fileName = extractFileName(item.src);
      } else if (item.src.startsWith('/')) {
        url = `${baseUrl}${item.src}`;
        fileName = extractFileName(item.src);
      } else if (item.src.startsWith('http')) {
        url = item.src;
        fileName = extractFileName(item.src);
      } else {
        url = `${baseUrl}/${item.src}`;
        fileName = extractFileName(item.src);
      }
      fileSize = item.fileSize || 0;
    } else if (typeof item === 'string') {
      url = item.startsWith('http') ? item : `${baseUrl}/file/${item}`;
      fileName = extractFileName(item);
    }
  } else if (result && typeof result === 'object') {
    if (result.url) {
      url = result.url;
      fileName = result.fileName || extractFileName(url);
      fileSize = result.fileSize || 0;
    } else if (result.src) {
      if (result.src.startsWith('/file/')) {
        url = `${baseUrl}${result.src}`;
        fileName = extractFileName(result.src);
      } else if (result.src.startsWith('/')) {
        url = `${baseUrl}${result.src}`;
        fileName = extractFileName(result.src);
      } else if (result.src.startsWith('http')) {
        url = result.src;
        fileName = extractFileName(result.src);
      } else {
        url = `${baseUrl}/${result.src}`;
        fileName = extractFileName(result.src);
      }
      fileSize = result.fileSize || 0;
    } else if (result.file) {
      url = `${baseUrl}/file/${result.file}`;
      fileName = result.fileName || extractFileName(result.file);
      fileSize = result.fileSize || 0;
    } else if (result.data && result.data.url) {
      url = result.data.url;
      fileName = result.data.fileName || extractFileName(url);
      fileSize = result.data.fileSize || 0;
    }
  } else if (typeof result === 'string') {
    if (result.startsWith('http://') || result.startsWith('https://')) {
      url = result;
      fileName = extractFileName(result);
    } else {
      url = `${baseUrl}/file/${result}`;
      fileName = extractFileName(result);
    }
  }

  console.log("URL cuối cùng đã trích xuất:", url);
  return { url, fileName, fileSize };
}

// Hàm bổ trợ: Trích xuất tên tệp từ URL
function extractFileName(url) {
  if (!url) return '';
  
  // Thử lấy phần cuối cùng
  let parts = url.split('/');
  let fileName = parts[parts.length - 1];
  
  // Nếu có tham số truy vấn, loại bỏ tham số truy vấn
  fileName = fileName.split('?')[0];
  
  // Nếu không có phần mở rộng, thử đoán dựa trên cấu trúc URL
  if (!fileName.includes('.') && url.includes('/file/')) {
    fileName = url.split('/file/')[1].split('?')[0];
    // Nếu vẫn không có phần mở rộng, có thể cần thêm một phần mở rộng mặc định dựa trên loại nội dung
    if (!fileName.includes('.')) {
      // Vì không có thông tin loại nội dung, tạm thời không thêm phần mở rộng
    }
  }
  
  return fileName || 'Tệp không xác định';
}

// Hàm getFile, nhận đối tượng env
async function getFile(fileId, env) {
  const BOT_TOKEN = env.BOT_TOKEN;
  const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`; // Xây dựng URL API
  
  // Thêm logic thử lại
  let retries = 0;
  const maxRetries = 3;
  let lastError = null;
  
  while (retries < maxRetries) {
    try {
      console.log(`Đang thử lấy thông tin tệp, fileId: ${fileId.substring(0, 10)}..., thử lần thứ ${retries + 1}`);
      const response = await fetch(`${API_URL}/getFile?file_id=${fileId}`);
      
      if (!response.ok) {
        throw new Error(`Telegram API trả về lỗi: ${response.status} ${response.statusText}`);
      }
      
      const result = await response.json();
      
      if (!result.ok) {
        throw new Error(`Telegram API trả về kết quả không thành công: ${JSON.stringify(result)}`);
      }
      
      if (!result.result || !result.result.file_path) {
        throw new Error(`Telegram API trả về kết quả thiếu file_path: ${JSON.stringify(result)}`);
      }
      
      return result;
    } catch (error) {
      lastError = error;
      console.error(`Lấy thông tin tệp thất bại, thử lần thứ ${retries + 1}: ${error.message}`);
      retries++;
      
      if (retries < maxRetries) {
        // Thời gian chờ tăng dần theo số lần thử lại
        const waitTime = 1000 * retries; // 1 giây, 2 giây, 3 giây...
        console.log(`Đợi ${waitTime / 1000} giây trước khi thử lại...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  console.error(`Lấy thông tin tệp thất bại, đã đạt số lần thử tối đa (${maxRetries}): ${lastError.message}`);
  return { ok: false, error: `Lấy thông tin tệp thất bại: ${lastError.message}` };
}

// Hàm sendMessage, nhận đối tượng env
async function sendMessage(chatId, text, env) {
  const BOT_TOKEN = env.BOT_TOKEN;
  
  // Đảm bảo BOT_TOKEN có sẵn
  if (!BOT_TOKEN) {
    console.error("sendMessage: BOT_TOKEN không khả dụng");
    return { ok: false, error: "BOT_TOKEN not available" };
  }
  
  const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
  console.log(`Sẵn sàng gửi tin nhắn tới Chat ID: ${chatId}, URL API: ${API_URL.substring(0, 40)}...`);
  
  try {
    const body = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
    });
    
    console.log(`Nội dung yêu cầu: ${body.substring(0, 50)}...`);
    
    const response = await fetch(`${API_URL}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: body,
    });
    
    console.log(`Trạng thái phản hồi Telegram API: ${response.status}`);
    const responseData = await response.json();
    console.log(`Dữ liệu phản hồi Telegram API: ${JSON.stringify(responseData).substring(0, 100)}...`);
    
    return responseData;
  } catch (error) {
    console.error(`Lỗi gửi tin nhắn: ${error}`);
    return { ok: false, error: error.message };
  }
}

// Hàm editMessage, dùng để cập nhật tin nhắn đã gửi
async function editMessage(chatId, messageId, text, env) {
  if (!messageId) return null;
  
  const BOT_TOKEN = env.BOT_TOKEN;
  const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`; // Xây dựng URL API
  
  try {
    const response = await fetch(`${API_URL}/editMessageText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: 'HTML',
      }),
    });
    return await response.json();
  } catch (error) {
    console.error('Cập nhật tin nhắn thất bại:', error);
    // Nếu cập nhật thất bại, thử gửi tin nhắn mới
    return sendMessage(chatId, text, env);
  }
}

// Lấy biểu tượng loại tệp
function getFileIcon(filename, mimeType) {
  if (mimeType) {
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('video/')) return '🎬';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.includes('pdf')) return '📄';
    if (mimeType.includes('msword') || mimeType.includes('document')) return '📝';
    if (mimeType.includes('excel') || mimeType.includes('sheet')) return '📊';
    if (mimeType.includes('powerpoint') || mimeType.includes('presentation')) return '📊';
    if (mimeType.includes('text/')) return '📝';
    if (mimeType.includes('zip') || mimeType.includes('compressed')) return '🗜️';
    if (mimeType.includes('html')) return '🌐';
    if (mimeType.includes('application/x-msdownload') || mimeType.includes('application/octet-stream')) return '⚙️';
  }
  
  if (filename) {
    const ext = filename.split('.').pop().toLowerCase();
    
    // Kiểm tra phần mở rộng có trong danh sách hỗ trợ không
    if (isExtValid(ext)) {
      // Tệp hình ảnh
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'tif', 'ico', 'heic', 'heif', 'avif', 'raw', 'arw', 'cr2', 'nef', 'orf', 'rw2', 'dng', 'raf'].includes(ext)) {
        return '🖼️';
      }
      
      // Tệp video
      if (['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm', 'm4v', '3gp', 'mpeg', 'mpg', 'mpe', 'ts', 'rmvb', 'rm', 'asf', 'amv', 'mts', 'm2ts', 'vob', 'divx', 'tp', 'ogm', 'ogv'].includes(ext)) {
        return '🎬';
      }
      
      // Tệp âm thanh
      if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus', 'mid', 'midi', 'ape', 'ra', 'amr', 'au', 'voc', 'ac3', 'dsf', 'dsd', 'dts', 'dtsma', 'ast', 'aiff', 'aifc', 'spx', 'gsm', 'wv', 'tta', 'mpc', 'tak'].includes(ext)) {
        return '🎵';
      }
      
      // Tệp ebook và tài liệu
      if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'md', 'csv', 'json', 'xml', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'djvu', 'cbz', 'cbr', 'lit', 'lrf', 'opf', 'prc', 'azw1', 'azw4', 'azw6', 'cb7', 'cbt', 'cba', 'chm', 'xps', 'oxps', 'ps', 'dvi'].includes(ext)) {
        return '📝';
      }
      
      // Tệp nén
      if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'tbz2', 'txz', 'z', 'lz', 'lzma', 'lzo', 'rz', 'sfx', 'cab', 'arj', 'lha', 'lzh', 'zoo', 'arc', 'ace', 'dgc', 'dgn', 'lbr', 'pak', 'pit', 'sit', 'sqx'].includes(ext)) {
        return '🗜️';
      }
      
      // Tệp thực thi và ứng dụng hệ thống
      if (['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'snap', 'flatpak', 'appimage', 'apk', 'ipa'].includes(ext)) {
        return '⚙️';
      }
      
      // Ảnh đĩa (Disk image)
      if (['iso', 'img', 'vdi', 'vmdk', 'vhd', 'vhdx', 'ova', 'ovf'].includes(ext)) {
        return '💿';
      }
      
      // Các định dạng ảnh ít phổ biến hơn
      if (['tiff', 'tif', 'bmp', 'pcx', 'tga', 'icns', 'heic', 'heif', 'arw', 'cr2', 'nef', 'orf', 'rw2', 'dng', 'raf', 'raw'].includes(ext)) {
        return '🖼️';
      }
      
      // Các định dạng lưu trữ ít phổ biến hơn
      if (['z', 'lz', 'lzma', 'lzo', 'rz', 'sfx', 'cab', 'arj', 'lha', 'lzh', 'zoo', 'arc', 'ace', 'dgc', 'dgn', 'lbr', 'pak', 'pit', 'sit', 'sqx', 'gz.gpg', 'z.gpg'].includes(ext)) {
        return '🗜️';
      }
      
      // Các định dạng video ít phổ biến hơn
      if (['rmvb', 'rm', 'asf', 'amv', 'mts', 'm2ts', 'vob', 'divx', 'mpeg', 'mpg', 'mpe', 'tp', 'ts', 'ogm', 'ogv'].includes(ext)) {
        return '🎬';
      }
      
      // Các định dạng âm thanh ít phổ biến hơn
      if (['ape', 'wma', 'ra', 'amr', 'au', 'voc', 'ac3', 'dsf', 'dsd', 'dts', 'dtsma', 'ast', 'aiff', 'aifc', 'spx', 'gsm', 'wv', 'tta', 'mpc', 'tak'].includes(ext)) {
        return '🎵';
      }
      
      // Các định dạng ebook và tài liệu ít phổ biến hơn
      if (['lit', 'lrf', 'opf', 'prc', 'azw1', 'azw4', 'azw6', 'cbz', 'cbr', 'cb7', 'cbt', 'cba', 'chm', 'xps', 'oxps', 'ps', 'dvi'].includes(ext)) {
        return '📝';
      }
      
      // Các định dạng phát triển và dữ liệu ít phổ biến hơn
      if (['wasm', 'wat', 'f', 'for', 'f90', 'f95', 'hs', 'lhs', 'elm', 'clj', 'csv', 'tsv', 'parquet', 'avro', 'proto', 'pbtxt', 'fbs'].includes(ext)) {
        return '📄';
      }
      
      // Các định dạng liên quan đến 3D và trò chơi
      if (['obj', 'fbx', 'dae', '3ds', 'stl', 'gltf', 'glb', 'blend', 'mb', 'unity3d', 'unitypackage', 'max', 'c4d', 'w3x', 'pk3', 'wad', 'bsp', 'map', 'rom', 'n64', 'z64', 'v64', 'nes', 'smc', 'sfc', 'gb', 'gbc', 'gba', 'nds'].includes(ext)) {
        return '🎨';
      }
      
      // Các định dạng khoa học và chuyên dụng
      if (['mat', 'fits', 'hdf', 'hdf5', 'h5', 'nx', 'ngc', 'nxs', 'nb', 'cdf', 'nc', 'spss', 'sav', 'dta', 'do', 'odb', 'odt', 'ott', 'odp', 'otp', 'ods', 'ots'].includes(ext)) {
        return '📊';
      }
    }
  }
  
  return '📄'; // Biểu tượng tệp mặc định
}

// Định dạng kích thước tệp
function formatFileSize(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Kiểm tra xem phần mở rộng tệp có trong danh sách hỗ trợ không
function isExtValid(fileExt) {
  return ['jpeg', 'jpg', 'png', 'gif', 'webp', 
    'mp4', 'mp3', 'ogg',
    'mp3', 'wav', 'flac', 'aac', 'opus',
    'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'pdf', 
    'txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'ts', 'go', 'java', 'php', 'py', 'rb', 'sh', 'bat', 'cmd', 'ps1', 'psm1', 'psd', 'ai', 'sketch', 'fig', 'svg', 'eps', 
    // Các định dạng nén
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'tbz2', 'txz',
    // Gói ứng dụng
    'apk', 'ipa', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'snap', 'flatpak', 'appimage',
    // Ảnh đĩa (Disk image)
    'iso', 'img', 'vdi', 'vmdk', 'vhd', 'vhdx', 'ova', 'ovf',
    // Định dạng tài liệu
    'epub', 'mobi', 'azw', 'azw3', 'fb2', 'djvu', 'cbz', 'cbr',
    // Font
    'ttf', 'otf', 'woff', 'woff2', 'eot', 
    // Các định dạng tệp khác
    'torrent', 'ico', 'crx', 'xpi', 'jar', 'war', 'ear',
    'qcow2', 'pvm', 'dsk', 'hdd', 'bin', 'cue', 'mds', 'mdf', 'nrg', 'ccd', 'cif', 'c2d', 'daa', 'b6t', 'b5t', 'bwt', 'isz', 'cdi', 'flp', 'uif', 'xdi', 'sdi',
    // Tệp mã nguồn
    'c', 'cpp', 'h', 'hpp', 'cs', 'swift', 'kt', 'rs', 'dart', 'lua', 'groovy', 'scala', 'perl', 'r', 'vbs', 'sql', 'yaml', 'yml', 'toml',
    // Liên quan đến video và âm thanh
    'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', '3gp', 'm4v', 'm4a', 'mid', 'midi',
    // Các định dạng ảnh ít phổ biến
    'tiff', 'tif', 'bmp', 'pcx', 'tga', 'icns', 'heic', 'heif', 'arw', 'cr2', 'nef', 'orf', 'rw2', 'dng', 'raf', 'raw',
    // Các định dạng nén ít phổ biến
    'z', 'lz', 'lzma', 'lzo', 'rz', 'sfx', 'cab', 'arj', 'lha', 'lzh', 'zoo', 'arc', 'ace', 'dgc', 'dgn', 'lbr', 'pak', 'pit', 'sit', 'sqx', 'gz.gpg', 'z.gpg',
    // Các định dạng video ít phổ biến
    'rmvb', 'rm', 'asf', 'amv', 'mts', 'm2ts', 'vob', 'divx', 'mpeg', 'mpg', 'mpe', 'tp', 'ts', 'ogm', 'ogv', 
    // Các định dạng âm thanh ít phổ biến
    'ape', 'wma', 'ra', 'amr', 'au', 'voc', 'ac3', 'dsf', 'dsd', 'dts', 'dtsma', 'ast', 'aiff', 'aifc', 'spx', 'gsm', 'wv', 'tta', 'mpc', 'tak',
    // Các định dạng ebook và tài liệu ít phổ biến
    'lit', 'lrf', 'opf', 'prc', 'azw1', 'azw4', 'azw6', 'cbz', 'cbr', 'cb7', 'cbt', 'cba', 'chm', 'xps', 'oxps', 'ps', 'dvi',
    // Các định dạng phát triển và dữ liệu ít phổ biến
    'wasm', 'wat', 'f', 'for', 'f90', 'f95', 'hs', 'lhs', 'elm', 'clj', 'csv', 'tsv', 'parquet', 'avro', 'proto', 'pbtxt', 'fbs',
    // Định dạng liên quan đến 3D và trò chơi
    'obj', 'fbx', 'dae', '3ds', 'stl', 'gltf', 'glb', 'blend', 'mb', 'unity3d', 'unitypackage', 'max', 'c4d', 'w3x', 'pk3', 'wad', 'bsp', 'map', 'rom', 'n64', 'z64', 'v64', 'nes', 'smc', 'sfc', 'gb', 'gbc', 'gba', 'nds',
    // Các định dạng khoa học và chuyên dụng
    'mat', 'fits', 'hdf', 'hdf5', 'h5', 'nx', 'ngc', 'nxs', 'nb', 'cdf', 'nc', 'spss', 'sav', 'dta', 'do', 'odb', 'odt', 'ott', 'odp', 'otp', 'ods', 'ots'
  ].includes(fileExt.toLowerCase());
}

// Cập nhật thống kê người dùng
async function updateUserStats(chatId, data, env) {
  try {
    if (!env.STATS_STORAGE) {
      console.log("KV Storage chưa cấu hình, bỏ qua cập nhật thống kê");
      return;
    }
    
    const statsKey = `user_stats_${chatId}`;
    const userStats = await getUserStats(chatId, env);
    
    // Cập nhật tổng dữ liệu tải lên
    userStats.totalUploads += 1;
    
    // Cập nhật bộ đếm loại tệp
    const fileType = data.fileType || 'other';
    userStats.fileTypes[fileType] = (userStats.fileTypes[fileType] || 0) + 1;
    
    // Cập nhật tổng kích thước
    if (data.fileSize) {
      userStats.totalSize += data.fileSize;
    }
    
    // Cập nhật số lượng thành công/thất bại
    if (data.success) {
      userStats.successfulUploads += 1;
      
      // Nếu tải lên thành công, thêm vào lịch sử
      if (!userStats.uploadHistory) {
        userStats.uploadHistory = [];
      }
      
      // Tạo mục lịch sử mới
      const historyEntry = {
        id: Date.now().toString(), // Sử dụng timestamp làm ID duy nhất
        timestamp: getChineseISOString(),
        fileName: data.fileName || `file_${Date.now()}`,
        fileType: fileType,
        fileSize: data.fileSize || 0,
        url: data.url || '',
        thumbnailUrl: data.thumbnailUrl || '',
        description: data.description || '' // Thêm trường ghi chú
      };
      
      // Thêm vào lịch sử, giữ bản ghi mới nhất ở đầu
      userStats.uploadHistory.unshift(historyEntry);
      
      // Giới hạn kích thước lịch sử, tối đa 100 bản ghi
      if (userStats.uploadHistory.length > 100) {
        userStats.uploadHistory = userStats.uploadHistory.slice(0, 100);
      }
    } else {
      userStats.failedUploads += 1;
    }
    
    // Cập nhật bản ghi thời gian
    const now = getCurrentChineseTime();
    const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    
    // Báo cáo hàng ngày
    if (!userStats.dailyData[todayStr]) {
      userStats.dailyData[todayStr] = {
        uploads: 0,
        size: 0,
        successful: 0,
        failed: 0
      };
    }
    userStats.dailyData[todayStr].uploads += 1;
    userStats.dailyData[todayStr].size += (data.fileSize || 0);
    if (data.success) {
      userStats.dailyData[todayStr].successful += 1;
    } else {
      userStats.dailyData[todayStr].failed += 1;
    }
    
    // Giới hạn kích thước dailyData, giữ lại dữ liệu 60 ngày gần nhất
    const dailyKeys = Object.keys(userStats.dailyData).sort();
    if (dailyKeys.length > 60) {
      const keysToRemove = dailyKeys.slice(0, dailyKeys.length - 60);
      keysToRemove.forEach(key => {
        delete userStats.dailyData[key];
      });
    }
    
    // Lưu dữ liệu thống kê đã cập nhật
    await env.STATS_STORAGE.put(statsKey, JSON.stringify(userStats));
    console.log(`Đã cập nhật dữ liệu thống kê cho người dùng ${chatId}`);
  } catch (error) {
    console.error(`Lỗi khi cập nhật dữ liệu thống kê người dùng:`, error);
  }
}

// Lấy dữ liệu thống kê người dùng
async function getUserStats(chatId, env) {
  try {
    if (!env.STATS_STORAGE) {
      console.log("KV Storage chưa được cấu hình, trả về thống kê trống");
      return createEmptyStats();
    }
    
    const statsKey = `user_stats_${chatId}`;
    const storedStats = await env.STATS_STORAGE.get(statsKey);
    
    if (!storedStats) {
      return createEmptyStats();
    }
    
    return JSON.parse(storedStats);
  } catch (error) {
    console.error(`Lỗi khi lấy dữ liệu thống kê người dùng:`, error);
    return createEmptyStats();
  }
}

// Tạo cấu trúc dữ liệu thống kê trống
function createEmptyStats() {
  return {
    totalUploads: 0,
    successfulUploads: 0,
    failedUploads: 0,
    totalSize: 0,
    fileTypes: {},
    dailyData: {},
    createdAt: getChineseISOString(),
    uploadHistory: [] // Thêm mảng lịch sử tải lên
  };
}

// Lấy báo cáo người dùng
async function getUserReport(chatId, period, env) {
  const stats = await getUserStats(chatId, env);
  
  // Lấy ngày hiện tại (múi giờ UTC+8)
  const now = getCurrentChineseTime();
  const report = {
    period: period,
    data: {}
  };
  
  if (period === 'daily') {
    // Báo cáo ngày chỉ trả về dữ liệu hôm nay
    const todayStr = now.toISOString().split('T')[0];
    if (stats.dailyData[todayStr]) {
      report.data[todayStr] = stats.dailyData[todayStr];
    }
  } else if (period === 'weekly') {
    // Báo cáo tuần trả về dữ liệu 7 ngày qua
    for (let i = 0; i < 7; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const chinaDate = toChineseTime(date);
      const dateStr = chinaDate.toISOString().split('T')[0];
      
      if (stats.dailyData[dateStr]) {
        report.data[dateStr] = stats.dailyData[dateStr];
      }
    }
  } else {
    // Báo cáo tháng trả về dữ liệu 30 ngày qua
    for (let i = 0; i < 30; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const chinaDate = toChineseTime(date);
      const dateStr = chinaDate.toISOString().split('T')[0];
      
      if (stats.dailyData[dateStr]) {
        report.data[dateStr] = stats.dailyData[dateStr];
      }
    }
  }
  
  return report;
}

// Định dạng tin nhắn thống kê
function formatStatsMessage(stats) {
  let message = `📊 *Thông tin thống kê người dùng* 📊\n\n`;
  
  message += `📤 *Tổng số tệp đã tải lên*: ${stats.totalUploads} tệp\n`;
  message += `📦 *Tổng dung lượng lưu trữ*: ${formatFileSize(stats.totalSize)}\n`;
  message += `✅ *Tải lên thành công*: ${stats.successfulUploads} tệp\n`;
  message += `❌ *Tải lên thất bại*: ${stats.failedUploads} tệp\n\n`;
  
  // Tính tỷ lệ thành công
  const successRate = stats.totalUploads > 0 
    ? Math.round((stats.successfulUploads / stats.totalUploads) * 100) 
    : 0;
  
  message += `📈 *Tỷ lệ thành công*: ${successRate}%\n\n`;
  
  // Thống kê theo loại tệp
  message += `*Phân bố theo loại tệp*:\n`;
  for (const [type, count] of Object.entries(stats.fileTypes)) {
    const icon = type === 'image' ? '🖼️' : 
                type === 'video' ? '🎬' : 
                type === 'audio' ? '🎵' : 
                type === 'animation' ? '🎞️' : 
                type === 'document' ? '📄' : '📁';
    message += `${icon} ${type}: ${count} tệp\n`;
  }
  
  return message;
}

// Định dạng tin nhắn lưu trữ
function formatStorageMessage(stats) {
  let message = `📊 *Tình trạng lưu trữ* 📊\n\n`;
  
  message += `📦 *Tổng dung lượng đã dùng*: ${formatFileSize(stats.totalSize)}\n\n`;
  
  // 基于文件类型的存储分布
  message += `*Phân bổ không gian lưu trữ*:\n`;
  
  // 遍历dailyData计算每种文件类型的总大小
  // 由于现在无法直接追踪每种类型的大小，这里只能显示总体情况
  
  // 计算平均文件大小
  // Tính kích thước tệp trung bình
  const avgFileSize = stats.totalUploads > 0 
    ? stats.totalSize / stats.totalUploads 
    : 0;
  
  message += `📊 *Kích thước tệp trung bình*: ${formatFileSize(avgFileSize)}\n\n`;
  
  // Thêm xu hướng sử dụng
  message += `📈 *Xu hướng lưu trữ*:\n`;
  message += `Sử dụng lệnh /report để xem báo cáo chi tiết\n`;
  
  return message;
}

// Định dạng tin nhắn báo cáo
function formatReportMessage(report, period) {
  const periodName = period === 'daily' ? 'Ngày' : 
                    period === 'weekly' ? 'Tuần' : 'Tháng';
  
  let message = `📊 *Báo cáo theo ${periodName}* 📊\n\n`;
  
  // Tính toán tổng cộng
  let totalUploads = 0;
  let totalSize = 0;
  let totalSuccessful = 0;
  let totalFailed = 0;
  
  for (const data of Object.values(report.data)) {
    totalUploads += data.uploads || 0;
    totalSize += data.size || 0;
    totalSuccessful += data.successful || 0;
    totalFailed += data.failed || 0;
  }
  
  message += `📤 *Tổng số tệp tải lên*: ${totalUploads} tệp\n`;
  message += `📦 *Tổng dung lượng*: ${formatFileSize(totalSize)}\n`;
  message += `✅ *Thành công*: ${totalSuccessful} tệp\n`;
  message += `❌ *Thất bại*: ${totalFailed} tệp\n\n`;
  
  // Chi tiết theo ngày/tuần/tháng
  message += `*Chi tiết dữ liệu ${periodName}*:\n`;
  
  // Sắp xếp theo ngày
  const sortedDates = Object.keys(report.data).sort();
  
  for (const date of sortedDates) {
    const data = report.data[date];
    message += `📅 ${date}: ${data.uploads || 0} tệp, ${formatFileSize(data.size || 0)}\n`;
  }
  
  return message;
}

// Định dạng tin nhắn tỷ lệ thành công
function formatSuccessRateMessage(stats) {
  let message = `📊 *Phân tích tỷ lệ thành công* 📊\n\n`;
  
  // Tính tỷ lệ thành công tổng thể
  const successRate = stats.totalUploads > 0 
    ? Math.round((stats.successfulUploads / stats.totalUploads) * 100) 
    : 0;
  
  message += `✅ *Tỷ lệ thành công tổng thể*: ${successRate}%\n`;
  message += `📤 *Tổng lượt tải lên*: ${stats.totalUploads} tệp\n`;
  message += `✓ *Thành công*: ${stats.successfulUploads} tệp\n`;
  message += `✗ *Thất bại*: ${stats.failedUploads} tệp\n\n`;
  
  // Tỷ lệ thành công theo loại tệp
  message += `*Số lượng theo loại tệp*:\n`;
  for (const [type, count] of Object.entries(stats.fileTypes)) {
    // Vì chúng tôi không theo dõi thành công/thất bại theo từng loại, nên ở đây chúng tôi chỉ hiển thị tổng số.
    const icon = type === 'image' ? '🖼️' : 
               type === 'video' ? '🎬' : 
               type === 'audio' ? '🎵' : 
               type === 'animation' ? '🎞️' : 
               type === 'document' ? '📄' : '📁';
    message += `${icon} ${type}: ${count} tệp\n`;
  }
  
  // Thêm xu hướng thời gian
  message += `\n📈 *Tần suất sử dụng*:\n`;
  message += `Sử dụng lệnh /report để xem báo cáo chi tiết\n`;
  
  return message;
}

// Xử lý lệnh lịch sử
async function handleHistoryCommand(chatId, page, fileType, searchQuery, descQuery, env) {
  try {
    // Số bản ghi hiển thị trên mỗi trang
    const ITEMS_PER_PAGE = 5;
    
    // Lấy dữ liệu thống kê người dùng
    const userStats = await getUserStats(chatId, env);
    
    // Kiểm tra xem có lịch sử tải lên không
    if (!userStats.uploadHistory || userStats.uploadHistory.length === 0) {
      await sendMessage(chatId, "📂 Bạn chưa tải lên bất kỳ tệp nào.", env);
      return;
    }
    
    // Kiểm tra xem có phải yêu cầu xóa không
    const args = fileType ? fileType.split('_') : [];
    if (args.length > 0 && args[0] === 'delete' && args[1]) {
      // Xử lý yêu cầu xóa
      const recordId = args[1];
      await handleDeleteHistoryRecord(chatId, recordId, env);
      return;
    }
    
    // Lọc lịch sử theo loại tệp
    let filteredHistory = userStats.uploadHistory;
    if (fileType && !fileType.startsWith('delete_')) {
      filteredHistory = filteredHistory.filter(entry => entry.fileType === fileType);
      
      if (filteredHistory.length === 0) {
        await sendMessage(chatId, `📂 Không tìm thấy bản ghi tải lên loại ${fileType}.`, env);
        return;
      }
    }
    
    // Chức năng tìm kiếm: Lọc theo từ khóa (bao gồm tên tệp và ghi chú)
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filteredHistory = filteredHistory.filter(entry => 
        (entry.fileName && entry.fileName.toLowerCase().includes(query)) ||
        (entry.description && entry.description.toLowerCase().includes(query))
      );
      
      if (filteredHistory.length === 0) {
        await sendMessage(chatId, `📂 Không tìm thấy bản ghi nào chứa từ khóa "${searchQuery}".`, env);
        return;
      }
    }
    
    // Chức năng tìm kiếm ghi chú: Lọc theo từ khóa ghi chú
    if (descQuery) {
      const descQueryLower = descQuery.toLowerCase();
      filteredHistory = filteredHistory.filter(entry => 
        entry.description && entry.description.toLowerCase().includes(descQueryLower)
      );
      
      if (filteredHistory.length === 0) {
        await sendMessage(chatId, `📂 Không tìm thấy bản ghi nào chứa ghi chú với từ khóa "${descQuery}".`, env);
        return;
      }
    }
    
    // Tính tổng số trang
    const totalPages = Math.ceil(filteredHistory.length / ITEMS_PER_PAGE);
    
    // Xác thực phạm vi số trang
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    
    // Tính toán bản ghi của trang hiện tại
    const startIndex = (page - 1) * ITEMS_PER_PAGE;
    const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, filteredHistory.length);
    const pageRecords = filteredHistory.slice(startIndex, endIndex);
    
    // Tạo tin nhắn lịch sử
    let message = `📋 *Lịch sử tải lên* ${fileType ? `(${fileType})` : ''} ${searchQuery ? `🔍Tìm kiếm: "${searchQuery}"` : ''} ${descQuery ? `🔍Tìm ghi chú: "${descQuery}"` : ''}\n\n`;
    
    for (let i = 0; i < pageRecords.length; i++) {
      const record = pageRecords[i];
      const date = new Date(record.timestamp);
      // Sử dụng giờ UTC+8
      const chinaDate = toChineseTime(date);
      const formattedDate = `${chinaDate.getFullYear()}-${String(chinaDate.getMonth() + 1).padStart(2, '0')}-${String(chinaDate.getDate()).padStart(2, '0')} ${String(chinaDate.getHours()).padStart(2, '0')}:${String(chinaDate.getMinutes()).padStart(2, '0')}`;
      
      // Lấy icon loại tệp
      const fileIcon = getFileTypeIcon(record.fileType);
      
      message += `${i + 1 + startIndex}. ${fileIcon} *${record.fileName}*\n`;
      
      // Nếu có ghi chú, hiển thị thông tin ghi chú
      if (record.description) {
        message += `   📝 Ghi chú: ${record.description}\n`;
      }
      
      message += `   📅 Thời gian: ${formattedDate}\n`;
      message += `   📦 Kích thước: ${formatFileSize(record.fileSize)}\n`;
      message += `   🔗 URL: ${record.url}\n`;
      message += `   🆔 Mã bản ghi: ${record.id}\n\n`;
    }
    
    // Thêm thông tin phân trang
    message += `📄 Trang: ${page}/${totalPages}`;
    
    // Thêm hướng dẫn điều hướng
    message += `\n\nSử dụng lệnh /history page${page+1} để xem trang tiếp theo`;
    if (page > 1) {
      message += `\nSử dụng lệnh /history page${page-1} để xem trang trước`;
    }
    
    // Thêm hướng dẫn lọc
    if (!fileType && !searchQuery && !descQuery) {
      message += `\n\nCó thể lọc theo loại tệp:\n/history image - Chỉ xem ảnh\n/history video - Chỉ xem video\n/history document - Chỉ xem tài liệu`;
    } else if (!searchQuery && !descQuery) {
      message += `\n\nSử dụng /history để xem tất cả các loại tệp`;
    } else if (!descQuery) {
      message += `\n\nSử dụng /history search:từ_khóa để tìm tệp chứa từ khóa`;
    } else {
      message += `\n\nSử dụng /history desc:từ_khóa để tìm ghi chú chứa từ khóa`;
    }
    
    // Thêm hướng dẫn tìm kiếm
    message += `\n\n🔍 Tìm kiếm theo tên tệp hoặc ghi chú:\n/history search:từ_khóa`;
    
    // Thêm hướng dẫn tìm kiếm ghi chú
    message += `\n\n🔍 Tìm kiếm theo ghi chú:\n/history desc:từ_khóa`;
    
    // Thêm hướng dẫn xóa
    message += `\n\n🗑️ Để xóa một bản ghi, sử dụng:\n/history delete_mã_bản_ghi`;
    
    await sendMessage(chatId, message, env);
  } catch (error) {
    console.error("Lỗi khi xử lý lệnh history:", error);
    await sendMessage(chatId, `❌ Lấy lịch sử tải lên thất bại: ${error.message}`, env);
  }
}

// Xử lý yêu cầu xóa bản ghi lịch sử
async function handleDeleteHistoryRecord(chatId, recordId, env) {
  try {
    if (!env.STATS_STORAGE) {
      await sendMessage(chatId, "❌ KV Storage chưa được cấu hình, không thể xóa bản ghi", env);
      return;
    }
    
    const statsKey = `user_stats_${chatId}`;
    const userStats = await getUserStats(chatId, env);
    
    if (!userStats.uploadHistory || userStats.uploadHistory.length === 0) {
      await sendMessage(chatId, "📂 Bạn chưa tải lên bất kỳ tệp nào.", env);
      return;
    }
    
    // Tìm vị trí bản ghi
    const recordIndex = userStats.uploadHistory.findIndex(record => record.id === recordId);
    
    if (recordIndex === -1) {
      await sendMessage(chatId, "❌ Không tìm thấy bản ghi được chỉ định, có thể đã bị xóa.", env);
      return;
    }
    
    // Lấy chi tiết bản ghi để gửi tin nhắn xác nhận
    const record = userStats.uploadHistory[recordIndex];
    
    // Xóa bản ghi
    userStats.uploadHistory.splice(recordIndex, 1);
    
    // Lưu dữ liệu thống kê đã cập nhật
    await env.STATS_STORAGE.put(statsKey, JSON.stringify(userStats));
    
    // Gửi tin nhắn xác nhận
    let confirmMessage = `✅ Đã xóa thành công bản ghi sau:\n\n` +
                         `📄 Tên tệp: ${record.fileName}\n`;
    
    // Nếu có ghi chú, thêm thông tin ghi chú
    if (record.description) {
      confirmMessage += `📝 Ghi chú: ${record.description}\n`;
    }
    
    confirmMessage += `📅 Thời gian: ${formatDate(record.timestamp)}\n` +
                     `🔗 URL: ${record.url}`;
    
    await sendMessage(chatId, confirmMessage, env);
  } catch (error) {
    console.error("Lỗi khi xóa bản ghi lịch sử:", error);
    await sendMessage(chatId, `❌ Xóa bản ghi thất bại: ${error.message}`, env);
  }
}

// Định dạng ngày tháng
function formatDate(dateString) {
  try {
    const date = new Date(dateString);
    // Điều chỉnh sang múi giờ UTC+8
    const chinaDate = toChineseTime(date);
    return `${chinaDate.getFullYear()}-${String(chinaDate.getMonth() + 1).padStart(2, '0')}-${String(chinaDate.getDate()).padStart(2, '0')} ${String(chinaDate.getHours()).padStart(2, '0')}:${String(chinaDate.getMinutes()).padStart(2, '0')}`;
  } catch (e) {
    return dateString;
  }
}

// Chuyển đổi thời gian sang múi giờ UTC+8
function toChineseTime(date) {
  // Tạo một đối tượng ngày mới để tránh sửa đổi đối tượng gốc
  const chinaDate = new Date(date);
  // Điều chỉnh sang múi giờ UTC+8, thêm số mili giây tương đương 8 giờ
  chinaDate.setTime(chinaDate.getTime() + 8 * 60 * 60 * 1000);
  return chinaDate;
}

// Lấy biểu tượng loại tệp
function getFileTypeIcon(fileType) {
  switch (fileType) {
    case 'image': return '🖼️';
    case 'video': return '🎬';
    case 'audio': return '🎵';
    case 'animation': return '🎞️';
    case 'document': return '📄';
    default: return '📁';
  }
}

// Quản lý chế độ bot công khai
async function getBotPublicMode(env) {
  try {
    if (!env.STATS_STORAGE) {
      console.error('STATS_STORAGE chưa được bind! Mặc định ở chế độ RIÊNG TƯ.');
      return false; // Fail-safe: không có KV → private để an toàn
    }
    const mode = await env.STATS_STORAGE.get('public_mode');
    if (mode === null) return true; // KV hoạt động nhưng chưa từng set → mặc định public
    return mode === 'true';
  } catch (error) {
    console.error('Lỗi khi lấy chế độ bot:', error);
    return false; // Lỗi → fail-safe về private
  }
}

async function updateBotPublicMode(mode, env) {
  try {
    if (!env.STATS_STORAGE) {
      console.error('STATS_STORAGE chưa được bind! Không thể lưu chế độ bot.');
      return false;
    }
    await env.STATS_STORAGE.put('public_mode', mode.toString());
    console.log(`Đã lưu chế độ bot vào KV: public_mode = ${mode}`);
    return true;
  } catch (error) {
    console.error('Lỗi khi cập nhật chế độ bot:', error);
    return false;
  }
}

// ── Utility chung cho config (env var ưu tiên, fallback KV) ──────────────
async function getKvConfig(key, envVar, env) {
  if (env[envVar]) return env[envVar];
  try {
    if (env.STATS_STORAGE) return await env.STATS_STORAGE.get(key);
  } catch(e) { console.error(`getKvConfig(${key}):`, e.message); }
  return null;
}
async function setKvConfig(key, value, env) {
  if (!env.STATS_STORAGE) throw new Error('STATS_STORAGE chưa được bind');
  await env.STATS_STORAGE.put(key, value);
}

// ── CF-imgbed Cross-Account Config helpers ────────────────────────────────
async function getCfBotToken(env)       { return getKvConfig('imgbed_cf_bot_token',   'IMGBED_CF_BOT_TOKEN',   env); }
async function getCfChatId(env)         { return getKvConfig('imgbed_tg_chat_id',     'IMGBED_TG_CHAT_ID',     env); }
async function getCfChannelName(env)    { return getKvConfig('imgbed_channel_name',   'IMGBED_CHANNEL_NAME',   env); }
async function getCfApiToken(env)       { return getKvConfig('imgbed_cf_api_token',   'IMGBED_CF_API_TOKEN',   env); }
async function getCfAccountId(env)      { return getKvConfig('imgbed_cf_account_id', 'IMGBED_CF_ACCOUNT_ID', env); }
async function getCfKvNamespaceId(env)  { return getKvConfig('imgbed_kv_namespace_id','IMGBED_KV_NAMESPACE_ID',env); }

// ── Trích xuất file_id và file_size từ Telegram Message object ────────────
function extractFileIdFromMessage(msg) {
  if (msg.photo)      return msg.photo[msg.photo.length - 1].file_id;
  if (msg.video)      return msg.video.file_id;
  if (msg.animation)  return msg.animation.file_id;
  if (msg.document)   return msg.document.file_id;
  if (msg.audio)      return msg.audio.file_id;
  if (msg.voice)      return msg.voice.file_id;
  if (msg.video_note) return msg.video_note.file_id;
  return null;
}
function extractFileSizeFromMessage(msg) {
  const obj = msg.photo ? msg.photo[msg.photo.length - 1]
             : (msg.video || msg.animation || msg.document || msg.audio || msg.voice || msg.video_note);
  return obj ? (obj.file_size || 0) : 0;
}

// ── Ghi metadata vào KV của CF-imgbed ─────────────────────────────────────
// Method 1 (ưu tiên): IMGBED_KV binding cùng CF account
// Method 2 (fallback): Cloudflare KV REST API (khác account)
async function writeToImgBedKV(key, metadata, env) {
  const valueStr = JSON.stringify(metadata);

  // Method 1: direct binding
  if (env.IMGBED_KV) {
    try {
      await env.IMGBED_KV.put(key, valueStr);
      console.log('[CopyMode] KV write via binding OK:', key);
      return true;
    } catch(e) {
      console.error('[CopyMode] Binding write failed:', e.message);
    }
  }

  // Method 2: Cloudflare KV REST API
  const cfApiToken = await getCfApiToken(env);
  const cfAccountId = await getCfAccountId(env);
  const cfKvNsId = await getCfKvNamespaceId(env);
  if (cfApiToken && cfAccountId && cfKvNsId) {
    try {
      const encodedKey = encodeURIComponent(key);
      const resp = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/storage/kv/namespaces/${cfKvNsId}/values/${encodedKey}`,
        { method: 'PUT', headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'application/json' }, body: valueStr }
      );
      const result = await resp.json();
      if (result.success) {
        console.log('[CopyMode] KV write via CF API OK:', key);
        return true;
      }
      console.error('[CopyMode] CF API KV write errors:', JSON.stringify(result.errors));
    } catch(e) {
      console.error('[CopyMode] CF API KV write exception:', e.message);
    }
  }
  return false;
}

// ── Auto-discover kênh CF-imgbed qua API (ưu tiên cache KV/env) ───────────
async function getImgBedChannelInfo(env) {
  // 1. Kiểm tra cache/override thủ công (env var > KV) — ưu tiên nhất
  const manualChatId = await getCfChatId(env);
  const manualName = await getCfChannelName(env);
  if (manualChatId) {
    console.log('[CopyMode] Dùng channel info từ config:', manualChatId, manualName);
    return { chatId: manualChatId, channelName: manualName || 'default' };
  }

  // 2. Cần admin token để gọi API tự động
  const adminToken = await getImgBedAdminToken(env);
  if (!adminToken) {
    throw new Error(
      'Chưa có thông tin kênh TG.\n' +
      '• Set thủ công: /admin cfchatid <id_kênh>\n' +
      '• Hoặc cấu hình auto: /admin cftoken <admin_token>'
    );
  }

  const baseUrl = new URL(env.IMG_BED_URL).origin;

  // 3. Thử endpoint /api/manage/list (với phân trang)
  try {
    const listUrl = `${baseUrl}/api/manage/list?page=1&limit=50`;
    console.log('[CopyMode] Gọi CF-imgbed API để lấy channel:', listUrl);
    const resp = await fetch(listUrl, {
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'authCode': adminToken
      }
    });
    const text = await resp.text();
    console.log('[CopyMode] API status:', resp.status, '| response (500 chars):', text.substring(0, 500));

    let data;
    try { data = JSON.parse(text); } catch(e) {
      throw new Error(`API trả về không phải JSON (status ${resp.status})`);
    }

    // Hỗ trợ nhiều cấu trúc response: {data:{files:[]}}, {data:{list:[]}}, {data:[]}, {files:[]}, {list:[]}
    const rawFiles = data?.data?.files ?? data?.data?.list ?? data?.data ?? data?.files ?? data?.list ?? [];
    const files = Array.isArray(rawFiles) ? rawFiles : (rawFiles && typeof rawFiles === 'object' ? Object.values(rawFiles) : []);
    console.log('[CopyMode] Số file tìm thấy từ API:', files.length);

    for (const file of files) {
      const meta = file?.metadata || file;
      const chatId = meta?.TgChatId;
      const channelName = meta?.ChannelName;
      if (chatId && chatId !== '0' && chatId !== 'undefined' && chatId !== '') {
        console.log('[CopyMode] Auto-discovered channel:', chatId, channelName);
        // Cache lại để lần sau khỏi phải gọi API
        try {
          if (env.STATS_STORAGE) {
            await env.STATS_STORAGE.put('imgbed_tg_chat_id', String(chatId));
            if (channelName) await env.STATS_STORAGE.put('imgbed_channel_name', channelName);
          }
        } catch(e) { console.log('[CopyMode] Cache write error (non-fatal):', e.message); }
        return { chatId: String(chatId), channelName: channelName || 'default' };
      }
    }

    if (files.length === 0) {
      // List rỗng: có thể auth sai hoặc chưa có file Telegram nào
      // Kiểm tra xem response có dấu hiệu auth lỗi không
      const lowerText = text.toLowerCase();
      if (resp.status === 401 || resp.status === 403 || lowerText.includes('unauthorized') || lowerText.includes('forbidden')) {
        throw new Error(
          `CF-imgbed từ chối xác thực (status ${resp.status}).\n` +
          'Kiểm tra lại token: /admin cftoken <token_mới>'
        );
      }
      throw new Error(
        'CF-imgbed chưa có file nào có TgChatId.\n' +
        'Cần set thủ công:\n' +
        '• /admin cfchatid <id_kênh_telegram>\n' +
        '• /admin cfchannel <tên_kênh> (tùy chọn)\n\n' +
        `Response API: ${text.substring(0, 200)}`
      );
    } else {
      // Có file nhưng không có TgChatId (không phải Telegram channel)
      throw new Error(
        'Các file trong CF-imgbed không có TgChatId (không dùng Telegram channel).\n' +
        'Hãy set thủ công:\n' +
        '• /admin cfchatid <id_kênh_telegram>\n' +
        '• /admin cfchannel <tên_kênh>'
      );
    }
  } catch(e) {
    // Re-throw user-facing errors (có hướng dẫn cho user)
    if (e.message.includes('/admin cf')) throw e;
    throw new Error(`Lỗi gọi CF-imgbed API: ${e.message}`);
  }
}

// ── Core Copy Mode: forward → ghi KV ─────────────────────────────────────
async function tryCopyMode(fromChatId, messageId, fileName, mimeType, description, env) {
  // 1. Lấy kênh CF-imgbed (auto hoặc thủ công)
  const channelInfo = await getImgBedChannelInfo(env);
  const { chatId: cfChatId, channelName: cfChannelName } = channelInfo;
  const BOT_TOKEN = env.BOT_TOKEN;

  // 2. copyMessage: copy file vào kênh CF-imgbed (không có "forwarded from"), với caption = description
  //    Bot upload đã là admin kênh CF-imgbed nên có quyền gửi vào kênh
  console.log(`[CopyMode] copyMessage → chat ${cfChatId}, from ${fromChatId}, msg ${messageId}`);
  const copyBody = { chat_id: cfChatId, from_chat_id: fromChatId, message_id: messageId };
  if (description) copyBody.caption = description; // Gắn mô tả vào caption của message đã copy
  const copyResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(copyBody)
  });
  const copyResult = await copyResp.json();
  if (!copyResult.ok) {
    throw new Error(
      `copyMessage thất bại: ${copyResult.description || copyResult.error_code}\n` +
      `💡 Đảm bảo bot này đã được thêm làm admin kênh TG ${cfChatId} của CF-imgbed.`
    );
  }
  const copiedMsgId = copyResult.result.message_id;
  console.log('[CopyMode] copyMessage OK. copiedMsgId:', copiedMsgId);

  // 3. Forward nội bộ trong kênh để lấy file_id (copyMessage chỉ trả về message_id)
  //    forward từ cf_channel → cf_channel (bot là admin nên có quyền)
  const internalFwdResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfChatId, from_chat_id: cfChatId, message_id: copiedMsgId })
  });
  const internalFwdResult = await internalFwdResp.json();
  if (!internalFwdResult.ok) {
    throw new Error(`Không thể lấy file_id từ kênh: ${internalFwdResult.description}`);
  }
  const newFileId = extractFileIdFromMessage(internalFwdResult.result);
  const fileSize = extractFileSizeFromMessage(internalFwdResult.result);
  if (!newFileId) throw new Error('Không tìm thấy file_id trong message được copy');
  console.log('[CopyMode] Got TgFileId:', newFileId.substring(0, 30) + '...');

  // 4. Xóa message forward nội bộ (chỉ dùng để lấy file_id, không cần giữ lại)
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfChatId, message_id: internalFwdResult.result.message_id })
    });
  } catch(e) {
    console.log('[CopyMode] deleteMessage (non-fatal):', e.message);
  }

  // 5. Tạo metadata theo đúng schema CF-imgbed
  const timestamp = Date.now();
  const uploadFolder = await getUploadFolder(env);
  const directory = (uploadFolder && uploadFolder !== '/') ? uploadFolder.replace(/^\//, '') : '';
  const normalizedFileName = fileName.replace(/\s+/g, '_');
  const kvKey = `${timestamp}_${normalizedFileName}`;

  const metadata = {
    FileName: fileName,
    FileType: mimeType,
    FileSize: (fileSize / (1024 * 1024)).toFixed(2),
    FileSizeBytes: fileSize,
    UploadIP: '0.0.0.0',
    UploadAddress: '未知',
    ListType: 'None',
    TimeStamp: timestamp,
    Label: 'None',
    Directory: directory,
    Tags: [],
    Channel: 'TelegramNew',
    ChannelName: cfChannelName,
    TgFileId: newFileId,
    TgChatId: String(cfChatId),
    // BOT_TOKEN của bot upload — CF-imgbed dùng token này để getFile khi serve
    // Hoạt động vì bot là admin kênh và có quyền truy cập file_id trong kênh đó
    TgBotToken: BOT_TOKEN
  };

  // 6. Ghi vào KV của CF-imgbed
  const writeOk = await writeToImgBedKV(kvKey, metadata, env);
  if (!writeOk) {
    throw new Error(
      'Không thể ghi vào KV CF-imgbed.\n' +
      'Kiểm tra: /admin cfstatus để xem cấu hình KV write.'
    );
  }

  // 7. Trả về URL theo format CF-imgbed
  const baseImgUrl = new URL(env.IMG_BED_URL).origin;
  const fileUrl = `${baseImgUrl}/file/${kvKey}`;
  return { url: fileUrl, fileName: normalizedFileName, fileSize, mode: 'copy' };
}

// Quản lý Copy Mode
async function getCopyMode(env) {
  try {
    if (!env.STATS_STORAGE) return false;
    const mode = await env.STATS_STORAGE.get('copy_mode');
    return mode === 'true';
  } catch (error) {
    console.error('Lỗi khi lấy copy mode:', error);
    return false;
  }
}

async function updateCopyMode(mode, env) {
  if (!env.STATS_STORAGE) throw new Error('STATS_STORAGE chưa được bind trong Cloudflare Dashboard');
  await env.STATS_STORAGE.put('copy_mode', mode.toString());
  console.log(`Đã lưu copy_mode = ${mode}`);
}

// Quản lý CF-imgbed Admin Token
async function getImgBedAdminToken(env) {
  try {
    if (!env.STATS_STORAGE) return null;
    return await env.STATS_STORAGE.get('imgbed_admin_token');
  } catch (error) {
    console.error('Lỗi khi lấy imgbed admin token:', error);
    return null;
  }
}

async function updateImgBedAdminToken(token, env) {
  if (!env.STATS_STORAGE) throw new Error('STATS_STORAGE chưa được bind trong Cloudflare Dashboard');
  await env.STATS_STORAGE.put('imgbed_admin_token', token);
  console.log('Đã lưu imgbed_admin_token');
}

// Quản lý thư mục tải lên
async function getUploadFolder(env) {
  try {
    if (!env.STATS_STORAGE) {
      console.error('STATS_STORAGE chưa được bind! Dùng thư mục gốc.');
      return '/';
    }
    const folder = await env.STATS_STORAGE.get('upload_folder');
    return folder || '/'; // Mặc định là thư mục gốc
  } catch (error) {
    console.error('Lỗi khi lấy thư mục tải lên:', error);
    return '/';
  }
}

async function updateUploadFolder(folder, env) {
  if (!env.STATS_STORAGE) {
    throw new Error('STATS_STORAGE chưa được bind trong Cloudflare Dashboard');
  }
  // Kiểm tra folder hợp lệ
  if (folder === undefined || folder === null) {
    throw new Error('Giá trị folder không hợp lệ: ' + String(folder));
  }
  await env.STATS_STORAGE.put('upload_folder', String(folder));
  console.log(`Đã lưu thư mục upload vào KV: upload_folder = ${folder}`);
  return true;
}

// Kiểm tra xem người dùng có bị cấm không
async function isUserBanned(userId, env) {
  try {
    if (!env.STATS_STORAGE) return false;
    
    const bannedUsersKey = 'banned_users';
    const bannedUsersData = await env.STATS_STORAGE.get(bannedUsersKey);
    
    if (!bannedUsersData) return false;
    
    const bannedUsers = JSON.parse(bannedUsersData);
    return bannedUsers.some(user => user.userId.toString() === userId.toString());
  } catch (error) {
    console.error('Lỗi khi kiểm tra người dùng bị cấm:', error);
    return false;
  }
}

// Cấm người dùng
async function banUser(userId, reason, env) {
  try {
    if (!env.STATS_STORAGE) return false;
    
    const bannedUsersKey = 'banned_users';
    const bannedUsersData = await env.STATS_STORAGE.get(bannedUsersKey);
    
    let bannedUsers = [];
    if (bannedUsersData) {
      bannedUsers = JSON.parse(bannedUsersData);
    }
    
    // Kiểm tra xem người dùng đã bị cấm chưa
    const existingIndex = bannedUsers.findIndex(user => user.userId.toString() === userId.toString());
    
    if (existingIndex !== -1) {
      // Cập nhật thông tin cấm
      bannedUsers[existingIndex] = {
        ...bannedUsers[existingIndex],
        reason: reason,
        bannedAt: getChineseISOString()
      };
    } else {
      // Thêm người dùng mới vào danh sách cấm
      bannedUsers.push({
        userId: userId,
        reason: reason,
        bannedAt: getChineseISOString(),
        bannedBy: 'admin' // Có thể đổi thành ghi lại ID hoặc tên admin thực tế
      });
    }
    
    await env.STATS_STORAGE.put(bannedUsersKey, JSON.stringify(bannedUsers));
    return true;
  } catch (error) {
    console.error('Lỗi khi cấm người dùng:', error);
    return false;
  }
}

// Giải lệnh cấm người dùng
async function unbanUser(userId, env) {
  try {
    if (!env.STATS_STORAGE) return false;
    
    const bannedUsersKey = 'banned_users';
    const bannedUsersData = await env.STATS_STORAGE.get(bannedUsersKey);
    
    if (!bannedUsersData) return true; // Không có danh sách cấm, trả về thành công trực tiếp
    
    let bannedUsers = JSON.parse(bannedUsersData);
    
    // Loại bỏ người dùng được chỉ định
    bannedUsers = bannedUsers.filter(user => user.userId.toString() !== userId.toString());
    
    await env.STATS_STORAGE.put(bannedUsersKey, JSON.stringify(bannedUsers));
    return true;
  } catch (error) {
    console.error('Lỗi khi giải lệnh cấm người dùng:', error);
    return false;
  }
}

// Lấy danh sách người dùng bị cấm
async function getBannedUsers(env) {
  try {
    if (!env.STATS_STORAGE) return [];
    
    const bannedUsersKey = 'banned_users';
    const bannedUsersData = await env.STATS_STORAGE.get(bannedUsersKey);
    
    if (!bannedUsersData) return [];
    
    return JSON.parse(bannedUsersData);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách người dùng bị cấm:', error);
    return [];
  }
}

// Thêm người dùng vào danh sách người dùng
async function addUserToList(userId, username, env) {
  try {
    if (!env.STATS_STORAGE) return false;
    
    const usersListKey = 'users_list';
    const usersListData = await env.STATS_STORAGE.get(usersListKey);
    
    let usersList = [];
    if (usersListData) {
      usersList = JSON.parse(usersListData);
    }
    
    // Kiểm tra xem người dùng đã tồn tại chưa
    const existingIndex = usersList.findIndex(user => user.userId.toString() === userId.toString());
    
    if (existingIndex !== -1) {
      // Cập nhật thông tin người dùng
      usersList[existingIndex] = {
        ...usersList[existingIndex],
        username: username,
        lastSeen: getChineseISOString()
      };
    } else {
      // Thêm người dùng mới
      usersList.push({
        userId: userId,
        username: username,
        firstSeen: getChineseISOString(),
        lastSeen: getChineseISOString()
      });
    }
    
    await env.STATS_STORAGE.put(usersListKey, JSON.stringify(usersList));
    return true;
  } catch (error) {
    console.error('Lỗi khi thêm người dùng vào danh sách:', error);
    return false;
  }
}

// Lấy tất cả người dùng
async function getAllUsers(env) {
  try {
    if (!env.STATS_STORAGE) return [];
    
    const usersListKey = 'users_list';
    const usersListData = await env.STATS_STORAGE.get(usersListKey);
    
    if (!usersListData) return [];
    
    const usersList = JSON.parse(usersListData);
    return usersList.map(user => user.userId);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách tất cả người dùng:', error);
    return [];
  }
}

// Lấy thống kê sử dụng bot
async function getBotStats(env) {
  try {
    if (!env.STATS_STORAGE) return {};
    
    // Lấy danh sách người dùng
    const usersListKey = 'users_list';
    const usersListData = await env.STATS_STORAGE.get(usersListKey);
    let usersList = [];
    if (usersListData) {
      usersList = JSON.parse(usersListData);
    }
    
    // Lấy danh sách người dùng bị cấm
    const bannedUsers = await getBannedUsers(env);
    
    // Tính toán tổng số lượng tải lên
    let totalUploads = 0;
    let totalSize = 0;
    
    // Duyệt qua tất cả người dùng để lấy thống kê tải lên
    for (const user of usersList) {
      const statsKey = `user_stats_${user.userId}`;
      const userStatsData = await env.STATS_STORAGE.get(statsKey);
      
      if (userStatsData) {
        const userStats = JSON.parse(userStatsData);
        totalUploads += userStats.totalUploads || 0;
        totalSize += userStats.totalSize || 0;
      }
    }
    
    return {
      totalUsers: usersList.length,
      totalUploads: totalUploads,
      totalSize: totalSize,
      bannedUsers: bannedUsers.length
    };
  } catch (error) {
    console.error('Lỗi khi lấy thống kê sử dụng bot:', error);
    return {};
  }
}

// Lấy thông tin chi tiết của tất cả người dùng
async function getAllUsersDetails(env) {
  try {
    if (!env.STATS_STORAGE) return [];
    
    const usersListKey = 'users_list';
    const usersListData = await env.STATS_STORAGE.get(usersListKey);
    
    if (!usersListData) return [];
    
    // Trả về danh sách chi tiết người dùng bao gồm thời gian, username, v.v.
    return JSON.parse(usersListData);
  } catch (error) {
    console.error('Lỗi khi lấy thông tin chi tiết tất cả người dùng:', error);
    return [];
  }
}

// Tạo hàm lấy thời gian hiện tại theo múi giờ UTC+8
function getCurrentChineseTime() {
  return toChineseTime(new Date());
}

// Tạo hàm lấy chuỗi ISO thời gian hiện tại theo múi giờ UTC+8
function getChineseISOString() {
  // Lấy thời gian hiện tại (đã điều chỉnh UTC+8)
  const chinaTime = getCurrentChineseTime();
  // Chuyển lại UTC để có chuỗi ISO chính xác
  const utcTime = new Date(chinaTime.getTime() - 8 * 60 * 60 * 1000);
  return utcTime.toISOString();
}

// Lấy cấu hình tự động dọn dẹp
async function getAutoCleanSettings(env) {
  try {
    if (!env.STATS_STORAGE) return null;
    
    const settingsKey = 'auto_clean_settings';
    const settingsData = await env.STATS_STORAGE.get(settingsKey);
    
    if (!settingsData) return null;
    
    return JSON.parse(settingsData);
  } catch (error) {
    console.error('Lỗi khi lấy cấu hình tự động dọn dẹp:', error);
    return null;
  }
}

// Cập nhật cấu hình tự động dọn dẹp
async function updateAutoCleanSettings(settings, env) {
  try {
    if (!env.STATS_STORAGE) return false;
    
    const settingsKey = 'auto_clean_settings';
    
    // Lấy cấu hình hiện tại
    const currentSettingsData = await env.STATS_STORAGE.get(settingsKey);
    let currentSettings = {};
    
    if (currentSettingsData) {
      currentSettings = JSON.parse(currentSettingsData);
    }
    
    // Hợp nhất cấu hình cũ và mới
    const newSettings = {
      ...currentSettings,
      ...settings,
      updatedAt: getChineseISOString()
    };
    
    await env.STATS_STORAGE.put(settingsKey, JSON.stringify(newSettings));
    return true;
  } catch (error) {
    console.error('Lỗi khi cập nhật cấu hình tự động dọn dẹp:', error);
    return false;
  }
}

// Dọn dẹp các hồ sơ trước số ngày chỉ định
async function cleanOldRecords(days, env) {
  try {
    if (!env.STATS_STORAGE) return 0;
    
    // Lấy tất cả người dùng
    const users = await getAllUsersDetails(env);
    let totalCleanedCount = 0;
    
    // Tính toán ngày giới hạn (thời gian hiện tại trừ đi số ngày chỉ định)
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
    const cutoffDateStr = cutoffDate.toISOString();
    
    console.log(`Bắt đầu dọn dẹp hồ sơ từ ${days} ngày trước, ngày giới hạn: ${cutoffDateStr}`);
    
    // Duyệt qua tất cả người dùng, dọn dẹp hồ sơ của họ
    for (const user of users) {
      const userId = user.userId;
      const statsKey = `user_stats_${userId}`;
      const userStatsData = await env.STATS_STORAGE.get(statsKey);
      
      if (userStatsData) {
        const userStats = JSON.parse(userStatsData);
        
        // Nếu có lịch sử tải lên, dọn dẹp các hồ sơ đã hết hạn
        if (userStats.uploadHistory && userStats.uploadHistory.length > 0) {
          const originalLength = userStats.uploadHistory.length;
          
          // Lọc giữ lại các hồ sơ sau ngày giới hạn
          userStats.uploadHistory = userStats.uploadHistory.filter(record => {
            // Kiểm tra xem dấu thời gian của hồ sơ có muộn hơn ngày giới hạn không
            return record.timestamp > cutoffDateStr;
          });
          
          const cleanedCount = originalLength - userStats.uploadHistory.length;
          totalCleanedCount += cleanedCount;
          
          if (cleanedCount > 0) {
            console.log(`Đã dọn dẹp ${cleanedCount} hồ sơ cho người dùng ${userId}`);
            
            // Lưu dữ liệu thống kê người dùng đã cập nhật
            await env.STATS_STORAGE.put(statsKey, JSON.stringify(userStats));
          }
        }
      }
    }
    
    console.log(`Tổng cộng đã dọn dẹp ${totalCleanedCount} hồ sơ`);
    return totalCleanedCount;
  } catch (error) {
    console.error('Lỗi khi dọn dẹp hồ sơ cũ:', error);
    return 0;
  }
}

// Kiểm tra và thực hiện tự động dọn dẹp
async function checkAndExecuteAutoClean(env) {
  try {
    const settings = await getAutoCleanSettings(env);
    
    // Nếu đã bật tự động dọn dẹp và đã thiết lập số ngày hợp lệ
    if (settings && settings.enabled && settings.days > 0) {
      // Kiểm tra thời gian dọn dẹp cuối cùng để tránh dọn dẹp thường xuyên
      const lastCleanTime = settings.lastCleanTime ? new Date(settings.lastCleanTime) : null;
      const now = new Date();
      
      // Nếu chưa bao giờ dọn dẹp hoặc cách lần dọn dẹp cuối cùng ít nhất 6 giờ
      const SIX_HOURS = 6 * 60 * 60 * 1000; // Số mili giây trong 6 giờ
      if (!lastCleanTime || (now.getTime() - lastCleanTime.getTime() > SIX_HOURS)) {
        console.log(`Thực hiện tự động dọn dẹp, dọn dẹp hồ sơ từ ${settings.days} ngày trước`);
        
        // Thực hiện thao tác dọn dẹp
        const cleanedCount = await cleanOldRecords(settings.days, env);
        
        // Cập nhật thời gian dọn dẹp cuối cùng
        await updateAutoCleanSettings({
          ...settings,
          lastCleanTime: now.toISOString()
        }, env);
        
        if (cleanedCount > 0) {
          console.log(`Tự động dọn dẹp hoàn tất, tổng cộng đã dọn dẹp ${cleanedCount} hồ sơ`);
        }
      } else {
        console.log(`Thời gian dọn dẹp cuối cùng là ${lastCleanTime.toISOString()}, chưa đạt đến khoảng thời gian dọn dẹp (6 giờ), bỏ qua dọn dẹp`);
      }
    }
  } catch (error) {
    console.error('Lỗi khi thực hiện tự động dọn dẹp:', error);
  }
}

// ===== 分片上传功能实现 =====

// Kiểm tra người dùng có đang ở chế độ tải lên phân đoạn không
async function isUserInChunkUploadMode(userId, env) {
  try {
    if (!env.STATS_STORAGE) return false;
    
    const chunkStateKey = `chunk_state_${userId}`;
    const chunkStateData = await env.STATS_STORAGE.get(chunkStateKey);
    
    return !!chunkStateData; // Nếu có dữ liệu trạng thái, nghĩa là người dùng đang ở chế độ tải lên phân đoạn
  } catch (error) {
    console.error('Lỗi khi kiểm tra chế độ tải lên phân đoạn của người dùng:', error);
    return false;
  }
}

// Bắt đầu quy trình tải lên phân đoạn
async function handleChunkUploadStart(chatId, userId, message, env) {
  try {
    if (!env.STATS_STORAGE) {
      await sendMessage(chatId, "❌ Không thể bắt đầu tải lên phân đoạn, dịch vụ lưu trữ chưa được cấu hình", env);
      return;
    }
    
    // Kiểm tra xem người dùng đã ở chế độ tải lên phân đoạn chưa
    const isInMode = await isUserInChunkUploadMode(userId, env);
    if (isInMode) {
      await sendMessage(chatId, "⚠️ Bạn đang trong chế độ tải lên phân đoạn.\n\nHãy tiếp tục gửi các mảnh tệp, hoặc sử dụng /chunk_cancel để hủy lần tải lên hiện tại.", env);
      return;
    }
    
    // Phân tích tham số, lấy tên tệp và số lượng phân đoạn
    const args = message.text.split(' ');
    let totalChunks = 0;
    let fileName = "";
    let fileDescription = "";
    
    if (args.length >= 2) {
      // Có thể là /chunk_upload 5 file.zip hoặc /chunk_upload file.zip
      if (!isNaN(parseInt(args[1]))) {
        totalChunks = parseInt(args[1]);
        fileName = args.length >= 3 ? args[2] : "merged_file";
      } else {
        fileName = args[1];
      }
      
      // Trích xuất mô tả tệp (nếu có)
      if (args.length > (totalChunks ? 3 : 2)) {
        fileDescription = args.slice(totalChunks ? 3 : 2).join(' ');
      }
    }
    
    // Nếu chưa chỉ định số phân đoạn, yêu cầu người dùng nhập
    if (totalChunks <= 0) {
      await sendMessage(chatId, "🔄 Vui lòng nhập số lượng phân đoạn và tên tệp:\n\nĐịnh dạng: `/chunk_upload số_phân_đoạn tên_tệp [mô_tả]`\n\nVí dụ: `/chunk_upload 5 video_lon.mp4 Video của tôi`", env);
      return;
    }
    
    // Xác thực tên tệp
    if (!fileName || fileName.length < 2) {
      fileName = `chunked_file_${Date.now()}`;
    }
    
    // Tạo trạng thái phiên tải lên
    const chunkState = {
      userId: userId,
      chatId: chatId,
      fileName: fileName,
      description: fileDescription,
      totalChunks: totalChunks,
      receivedChunks: 0,
      chunks: {},
      startTime: getChineseISOString(),
      lastActivity: getChineseISOString(),
      totalSize: 0,
      status: 'waiting' // waiting, receiving, merging, complete, failed
    };
    
    // Lưu trạng thái phiên
    const chunkStateKey = `chunk_state_${userId}`;
    await env.STATS_STORAGE.put(chunkStateKey, JSON.stringify(chunkState));
    
    // Gửi tin nhắn hướng dẫn
    const instructionMsg = `📤 *Đã bắt đầu tải lên phân đoạn*\n\n` +
                          `📋 Tên tệp: ${fileName}\n` +
                          `📦 Tổng số phân đoạn: ${totalChunks}\n` +
                          `📝 Mô tả tệp: ${fileDescription || 'Không có'}\n\n` +
                          `Vui lòng thực hiện theo các bước sau:\n` +
                          `1. Vui lòng gửi từng mảnh tệp (tổng cộng ${totalChunks} mảnh)\n` +
                          `2. Các mảnh sẽ được hợp nhất theo thứ tự gửi\n` +
                          `3. Sau khi tất cả các mảnh được tải lên, hệ thống sẽ tự động hợp nhất và tải lên\n\n` +
                          `⚠️ Lưu ý:\n` +
                          `- Mỗi mảnh phải nhỏ hơn 20MB\n` +
                          `- Vui lòng không gửi tin nhắn khác trong quá trình tải lên phân đoạn\n` +
                          `- Sử dụng /chunk_cancel để hủy tải lên\n\n` +
                          `🔄 Vui lòng gửi mảnh thứ 1...`;
    
    await sendMessage(chatId, instructionMsg, env);
  } catch (error) {
    console.error('Lỗi khi bắt đầu tải lên phân đoạn:', error);
    await sendMessage(chatId, `❌ Lỗi khi bắt đầu tải lên phân đoạn: ${error.message}`, env);
  }
}

// Xử lý tin nhắn trong quá trình tải lên phân đoạn
async function handleChunkUploadMessage(message, chatId, userId, env) {
  try {
    if (!env.STATS_STORAGE) {
      await sendMessage(chatId, "❌ Dịch vụ lưu trữ chưa được cấu hình, không thể tiếp tục tải lên phân đoạn", env);
      return;
    }
    
    // Lấy trạng thái phiên hiện tại
    const chunkStateKey = `chunk_state_${userId}`;
    const chunkStateData = await env.STATS_STORAGE.get(chunkStateKey);
    
    if (!chunkStateData) {
      await sendMessage(chatId, "❌ Phiên tải lên phân đoạn đã hết hạn, vui lòng bắt đầu lại. Sử dụng lệnh /chunk_upload để bắt đầu tải lên mới.", env);
      return;
    }
    
    let chunkState = JSON.parse(chunkStateData);
    
    // Kiểm tra xem có phải lệnh hủy không
    if (message.text && message.text.startsWith('/chunk_cancel')) {
      await handleChunkUploadCancel(chatId, userId, env);
      return;
    }
    
    // Kiểm tra xem có nhận được tệp không
    let fileId = null;
    let fileType = 'document';
    let fileName = '';
    let fileSize = 0;
    
    if (message.document) {
      fileId = message.document.file_id;
      fileName = message.document.file_name || `chunk_${chunkState.receivedChunks + 1}`;
      fileSize = message.document.file_size || 0;
    } else if (message.photo && message.photo.length > 0) {
      fileId = message.photo[message.photo.length - 1].file_id;
      fileType = 'image';
      fileName = `image_chunk_${chunkState.receivedChunks + 1}.jpg`;
      fileSize = message.photo[message.photo.length - 1].file_size || 0;
    } else if (message.video) {
      fileId = message.video.file_id;
      fileType = 'video';
      fileName = message.video.file_name || `video_chunk_${chunkState.receivedChunks + 1}.mp4`;
      fileSize = message.video.file_size || 0;
    } else if (message.audio) {
      fileId = message.audio.file_id;
      fileType = 'audio';
      fileName = message.audio.file_name || `audio_chunk_${chunkState.receivedChunks + 1}.mp3`;
      fileSize = message.audio.file_size || 0;
    } else if (message.animation) {
      fileId = message.animation.file_id;
      fileType = 'animation';
      fileName = message.animation.file_name || `animation_chunk_${chunkState.receivedChunks + 1}.gif`;
      fileSize = message.animation.file_size || 0;
    } else {
      // Nếu không phải tin nhắn tệp, gửi lời nhắc
      await sendMessage(chatId, `⚠️ Vui lòng gửi mảnh tệp. Bạn đã tải lên ${chunkState.receivedChunks}/${chunkState.totalChunks} mảnh.`, env);
      return;
    }
    
    // Gửi tin nhắn đang xử lý
    const sendResult = await sendMessage(chatId, `🔄 Đang xử lý mảnh thứ ${chunkState.receivedChunks + 1}/${chunkState.totalChunks}...`, env);
    const messageId = sendResult && sendResult.ok ? sendResult.result.message_id : null;
    
    try {
      // Lấy tệp
      const fileInfo = await getFile(fileId, env);
      
      if (!fileInfo || !fileInfo.ok) {
        throw new Error('Lấy thông tin tệp thất bại');
      }
      
      const filePath = fileInfo.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
      
      // Tải nội dung tệp
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Tải tệp thất bại: ${response.status}`);
      }
      
      const buffer = await response.arrayBuffer();
      
      // Cập nhật trạng thái phiên
      chunkState.receivedChunks += 1;
      chunkState.lastActivity = getChineseISOString();
      chunkState.totalSize += buffer.byteLength;
      chunkState.status = 'receiving';
      
      // Sử dụng lưu trữ KV cho dữ liệu mảnh (nếu mảnh quá lớn, có thể cần sử dụng Cloudflare R2 hoặc lưu trữ đối tượng khác)
      const chunkKey = `chunk_${userId}_${chunkState.receivedChunks}`;
      await env.STATS_STORAGE.put(chunkKey, buffer);
      
      // Cập nhật thông tin mảnh
      chunkState.chunks[chunkState.receivedChunks] = {
        key: chunkKey,
        size: buffer.byteLength,
        originalName: fileName,
        type: fileType
      };
      
      // Gửi tin nhắn tiến độ
      const progressMsg = `✅ Đã nhận mảnh thứ ${chunkState.receivedChunks}/${chunkState.totalChunks}\n` +
                        `📦 Kích thước: ${formatFileSize(buffer.byteLength)}\n` +
                        `📋 Tên tệp: ${fileName}\n` +
                        `📊 Tổng tiến độ: ${Math.round((chunkState.receivedChunks / chunkState.totalChunks) * 100)}%`;
      
      if (messageId) {
        await editMessage(chatId, messageId, progressMsg, env);
      } else {
        await sendMessage(chatId, progressMsg, env);
      }
      
      // Kiểm tra xem tất cả các mảnh đã được nhận chưa
      if (chunkState.receivedChunks === chunkState.totalChunks) {
        // Tất cả mảnh đã nhận xong, bắt đầu hợp nhất
        await sendMessage(chatId, `🔄 Tất cả các mảnh đã nhận đủ, đang hợp nhất tệp...`, env);
        
        // Cập nhật trạng thái
        chunkState.status = 'merging';
        await env.STATS_STORAGE.put(chunkStateKey, JSON.stringify(chunkState));
        
        // Hợp nhất tệp và tải lên
        await mergeAndUploadChunks(chatId, userId, env);
      } else {
        // Lưu trạng thái phiên đã cập nhật
        await env.STATS_STORAGE.put(chunkStateKey, JSON.stringify(chunkState));
        
        // Nhắc tải lên mảnh tiếp theo
        await sendMessage(chatId, `🔄 Vui lòng gửi mảnh thứ ${chunkState.receivedChunks + 1}/${chunkState.totalChunks}...`, env);
      }
    } catch (error) {
      console.error('Lỗi khi xử lý mảnh:', error);
      
      if (messageId) {
        await editMessage(chatId, messageId, `❌ Lỗi khi xử lý mảnh: ${error.message}`, env);
      } else {
        await sendMessage(chatId, `❌ Lỗi khi xử lý mảnh: ${error.message}`, env);
      }
      
      // Cập nhật trạng thái thất bại
      chunkState.status = 'failed';
      await env.STATS_STORAGE.put(chunkStateKey, JSON.stringify(chunkState));
    }
  } catch (error) {
    console.error('Lỗi khi xử lý tin nhắn tải lên phân đoạn:', error);
    await sendMessage(chatId, `❌ Lỗi khi tải lên phân đoạn: ${error.message}`, env);
  }
}

// Hủy tải lên phân đoạn
async function handleChunkUploadCancel(chatId, userId, env) {
  try {
    if (!env.STATS_STORAGE) {
      await sendMessage(chatId, "❌ Dịch vụ lưu trữ chưa được cấu hình, không thể hủy tải lên", env);
      return;
    }
    
    // Lấy trạng thái phiên hiện tại
    const chunkStateKey = `chunk_state_${userId}`;
    const chunkStateData = await env.STATS_STORAGE.get(chunkStateKey);
    
    if (!chunkStateData) {
      await sendMessage(chatId, "⚠️ Không có lần tải lên phân đoạn nào đang diễn ra", env);
      return;
    }
    
    // Phân tích trạng thái phiên
    const chunkState = JSON.parse(chunkStateData);
    
    // Xóa tất cả dữ liệu mảnh
    for (const chunkNum in chunkState.chunks) {
      const chunkKey = chunkState.chunks[chunkNum].key;
      await env.STATS_STORAGE.delete(chunkKey);
    }
    
    // Xóa trạng thái phiên
    await env.STATS_STORAGE.delete(chunkStateKey);
    
    // Gửi tin nhắn xác nhận hủy
    await sendMessage(chatId, "✅ Đã hủy tải lên phân đoạn, tất cả dữ liệu tạm thời đã được xóa", env);
  } catch (error) {
    console.error('Lỗi khi hủy tải lên phân đoạn:', error);
    await sendMessage(chatId, `❌ Lỗi khi hủy tải lên phân đoạn: ${error.message}`, env);
  }
}

// Hợp nhất các mảnh và tải lên
async function mergeAndUploadChunks(chatId, userId, env) {
  try {
    if (!env.STATS_STORAGE) {
      await sendMessage(chatId, "❌ Dịch vụ lưu trữ chưa được cấu hình, không thể hợp nhất các mảnh", env);
      return;
    }
    
    // Lấy trạng thái phiên hiện tại
    const chunkStateKey = `chunk_state_${userId}`;
    const chunkStateData = await env.STATS_STORAGE.get(chunkStateKey);
    
    if (!chunkStateData) {
      await sendMessage(chatId, "❌ Phiên tải lên phân đoạn đã hết hạn", env);
      return;
    }
    
    const chunkState = JSON.parse(chunkStateData);
    
    // Gửi tin nhắn đang xử lý
    const sendResult = await sendMessage(chatId, `🔄 Đang hợp nhất ${chunkState.totalChunks} mảnh và tải lên tệp...`, env);
    const messageId = sendResult && sendResult.ok ? sendResult.result.message_id : null;
    
    try {
      // Hợp nhất tất cả các mảnh
      let mergedBuffer = new Uint8Array(chunkState.totalSize);
      let offset = 0;
      
      // Hợp nhất các mảnh theo đúng thứ tự
      for (let i = 1; i <= chunkState.totalChunks; i++) {
        const chunkInfo = chunkState.chunks[i];
        if (!chunkInfo) {
          throw new Error(`Thiếu mảnh thứ ${i}`);
        }
        
        // Lấy dữ liệu mảnh
        const chunkData = await env.STATS_STORAGE.get(chunkInfo.key, 'arrayBuffer');
        if (!chunkData) {
          throw new Error(`Không thể lấy dữ liệu mảnh thứ ${i}`);
        }
        
        // Sao chép vào bộ đệm hợp nhất
        new Uint8Array(mergedBuffer.buffer).set(new Uint8Array(chunkData), offset);
        offset += chunkData.byteLength;
        
        // Cập nhật tiến độ
        if (messageId) {
          await editMessage(chatId, messageId, `🔄 Đang hợp nhất: ${i}/${chunkState.totalChunks} mảnh (${Math.round((i / chunkState.totalChunks) * 100)}%)`, env);
        }
      }
      
      // Chuẩn bị tải lên
      if (messageId) {
        await editMessage(chatId, messageId, `🔄 Hợp nhất các mảnh hoàn tất, đang tải lên tệp...`, env);
      }
      
      // Tải lên tệp đã hợp nhất
      const formData = new FormData();
      const mimeType = getMimeTypeFromFileName(chunkState.fileName);
      formData.append('file', new File([mergedBuffer], chunkState.fileName, { type: mimeType }));
      
      const uploadUrl = new URL(env.IMG_BED_URL);
      uploadUrl.searchParams.append('returnFormat', 'full');

      // Gắn thư mục tải lên nếu có cấu hình
      const uploadFolder = await getUploadFolder(env);
      if (uploadFolder && uploadFolder !== '/') {
        uploadUrl.searchParams.append('uploadFolder', uploadFolder);
        formData.append('uploadFolder', uploadFolder);
      }
      
      if (env.AUTH_CODE) {
        uploadUrl.searchParams.append('authCode', env.AUTH_CODE);
      }
      
      console.log(`URL yêu cầu tải lên tệp sau khi hợp nhất: ${uploadUrl.toString()}`);
      
      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: env.AUTH_CODE ? { 'Authorization': `Bearer ${env.AUTH_CODE}` } : {},
        body: formData
      });
      
      const responseText = await uploadResponse.text();
      console.log('Phản hồi thô khi tải lên tệp hợp nhất:', responseText);
      
      let uploadResult;
      try {
        uploadResult = JSON.parse(responseText);
      } catch (e) {
        uploadResult = responseText;
      }
      
      const extractedResult = extractUrlFromResult(uploadResult, env.IMG_BED_URL);
      const fileUrl = extractedResult.url;
      
      if (fileUrl) {
        // Tải lên thành công
        chunkState.status = 'complete';
        chunkState.finalUrl = fileUrl;
        await env.STATS_STORAGE.put(chunkStateKey, JSON.stringify(chunkState));
        
        // Xây dựng tin nhắn thành công
        let successMsg = `✅ Tải lên phân đoạn thành công!\n\n` +
                        `📄 Tên tệp: ${chunkState.fileName}\n`;
        
        // Nếu có mô tả tệp, thêm thông tin ghi chú
        if (chunkState.description) {
          successMsg += `📝 Ghi chú: ${chunkState.description}\n`;
        }
        
        successMsg += `📦 Kích thước tệp: ${formatFileSize(chunkState.totalSize)}\n` +
                     `🧩 Số mảnh: ${chunkState.totalChunks}\n\n` +
                     `🔗 URL: ${fileUrl}`;
        
        if (messageId) {
          await editMessage(chatId, messageId, successMsg, env);
        } else {
          await sendMessage(chatId, successMsg, env);
        }
        
        // Cập nhật dữ liệu thống kê người dùng
        await updateUserStats(chatId, {
          fileType: 'document',
          fileSize: chunkState.totalSize,
          success: true,
          fileName: chunkState.fileName,
          url: fileUrl,
          description: chunkState.description
        }, env);
        
        // Dọn dẹp dữ liệu mảnh tạm thời
        cleanupChunkData(userId, chunkState, env);
      } else {
        // Tải lên thất bại
        throw new Error('Không thể lấy được URL tải lên');
      }
    } catch (error) {
      console.error('Lỗi khi hợp nhất mảnh và tải lên:', error);
      
      if (messageId) {
        await editMessage(chatId, messageId, `❌ Lỗi khi hợp nhất mảnh và tải lên: ${error.message}`, env);
      } else {
        await sendMessage(chatId, `❌ Lỗi khi hợp nhất mảnh và tải lên: ${error.message}`, env);
      }
      
      // Cập nhật trạng thái thành thất bại
      chunkState.status = 'failed';
      await env.STATS_STORAGE.put(chunkStateKey, JSON.stringify(chunkState));
    }
  } catch (error) {
    console.error('Lỗi khi hợp nhất mảnh và tải lên:', error);
    await sendMessage(chatId, `❌ Lỗi khi hợp nhất mảnh và tải lên: ${error.message}`, env);
  }
}

// Dọn dẹp dữ liệu mảnh
async function cleanupChunkData(userId, chunkState, env) {
  try {
    // Xóa tất cả dữ liệu mảnh
    for (const chunkNum in chunkState.chunks) {
      const chunkKey = chunkState.chunks[chunkNum].key;
      await env.STATS_STORAGE.delete(chunkKey);
    }
    
    // Xóa trạng thái phiên
    const chunkStateKey = `chunk_state_${userId}`;
    await env.STATS_STORAGE.delete(chunkStateKey);
    
    console.log(`Đã dọn dẹp dữ liệu tạm thời tải lên phân đoạn của người dùng ${userId}`);
  } catch (error) {
    console.error('Lỗi khi dọn dẹp dữ liệu mảnh:', error);
  }
}

// Lấy loại MIME dựa trên tên tệp
function getMimeTypeFromFileName(fileName) {
  if (!fileName) return 'application/octet-stream';
  
  const ext = fileName.split('.').pop().toLowerCase();
  
  // Loại hình ảnh
  if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  
  // Loại video
  if (['mp4', 'm4v'].includes(ext)) return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'avi') return 'video/x-msvideo';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'wmv') return 'video/x-ms-wmv';
  if (ext === 'flv') return 'video/x-flv';
  
  // Loại âm thanh
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'ogg') return 'audio/ogg';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'aac') return 'audio/aac';
  if (ext === 'm4a') return 'audio/mp4';
  
  // Loại tài liệu
  if (ext === 'pdf') return 'application/pdf';
  if (['doc', 'docx'].includes(ext)) return 'application/msword';
  if (['xls', 'xlsx'].includes(ext)) return 'application/vnd.ms-excel';
  if (['ppt', 'pptx'].includes(ext)) return 'application/vnd.ms-powerpoint';
  if (ext === 'txt') return 'text/plain';
  if (ext === 'html') return 'text/html';
  if (ext === 'css') return 'text/css';
  if (ext === 'js') return 'application/javascript';
  
  // Tệp nén
  if (ext === 'zip') return 'application/zip';
  if (ext === 'rar') return 'application/x-rar-compressed';
  if (ext === '7z') return 'application/x-7z-compressed';
  if (['tar', 'gz', 'bz2'].includes(ext)) return 'application/x-compressed';
  
  // Loại nhị phân mặc định
  return 'application/octet-stream';
}
