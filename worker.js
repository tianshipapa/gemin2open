/**
 * Cloudflare Worker: Gemini to OpenAI API Proxy
 * 部署后，baseURL 填写 Worker 的地址，API Key 填写你的 Gemini API Key
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 只处理 /v1/chat/completions 的 POST 请求
    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      try {
        const openaiReq = await request.json();

        // 从 Authorization 头中提取 Gemini API Key
        const authHeader = request.headers.get('Authorization') || '';
        const apiKey = authHeader.replace('Bearer ', '').trim();

        if (!apiKey) {
          return new Response(
            JSON.stringify({ error: '未提供 API Key，请在 Authorization 头中携带 Gemini API Key' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // 模型映射（如果你在客户端填了 gpt-3.5-turbo，会自动映射到 gemini 模型）
        const modelMap = {
          'gpt-3.5-turbo': 'gemini-2.0-flash',
          'gpt-4': 'gemini-2.0-flash',
          'gpt-4o': 'gemini-2.0-flash',
        };
        const model = modelMap[openaiReq.model] || openaiReq.model || 'gemini-2.0-flash';
        const isStream = openaiReq.stream || false;

        // 将 OpenAI messages 转换为 Gemini contents
        const contents = [];
        let systemInstruction = '';

        for (const msg of openaiReq.messages || []) {
          if (msg.role === 'system') {
            systemInstruction = msg.content;
            continue;
          }
          // Gemini 的角色是 'user' 或 'model'
          const role = msg.role === 'assistant' ? 'model' : 'user';
          contents.push({
            role: role,
            parts: [{ text: msg.content }],
          });
        }

        // 构建 Gemini API URL
        const geminiEndpoint = isStream ? 'streamGenerateContent' : 'generateContent';
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${geminiEndpoint}?key=${apiKey}&alt=${isStream ? 'sse' : 'json'}`;

        // 构建 Gemini 请求体
        const geminiBody = {
          contents: contents,
          ...(systemInstruction && {
            systemInstruction: { parts: [{ text: systemInstruction }] },
          }),
          generationConfig: {
            ...(openaiReq.temperature !== undefined && { temperature: openaiReq.temperature }),
            ...(openaiReq.max_tokens !== undefined && { maxOutputTokens: openaiReq.max_tokens }),
            ...(openaiReq.top_p !== undefined && { topP: openaiReq.top_p }),
          },
        };

        // 调用 Gemini API
        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiBody),
        });

        // ===== 非流式响应 =====
        if (!isStream) {
          if (!geminiRes.ok) {
            const errText = await geminiRes.text();
            return new Response(errText, { status: geminiRes.status });
          }
          const geminiData = await geminiRes.json();
          const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

          const openaiResponse = {
            id: 'chatcmpl-' + Math.random().toString(36).substring(2, 11),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: text },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };

          return new Response(JSON.stringify(openaiResponse), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // ===== 流式响应 =====
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        (async () => {
          const reader = geminiRes.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                await writer.write(encoder.encode('data: [DONE]\n\n'));
                break;
              }
              const chunk = decoder.decode(value, { stream: true });
              const lines = chunk.split('\n');

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const jsonStr = line.slice(6).trim();
                  if (!jsonStr) continue;
                  try {
                    const data = JSON.parse(jsonStr);
                    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    if (text) {
                      const openaiChunk = {
                        id: 'chatcmpl-' + Math.random().toString(36).substring(2, 11),
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: model,
                        choices: [
                          {
                            index: 0,
                            delta: { content: text },
                            finish_reason: null,
                          },
                        ],
                      };
                      await writer.write(
                        encoder.encode('data: ' + JSON.stringify(openaiChunk) + '\n\n')
                      );
                    }
                  } catch (e) {
                    // 忽略解析错误
                  }
                }
              }
            }
          } catch (err) {
            console.error(err);
          } finally {
            writer.close();
          }
        })();

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });

      } catch (err) {
        return new Response(
          JSON.stringify({ error: '服务器内部错误: ' + err.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // 健康检查 / 其他请求
    if (url.pathname === '/' || url.pathname === '/v1') {
      return new Response(JSON.stringify({ message: 'Gemini to OpenAI Proxy is running!' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
