export async function onRequestPost(context) {
  const { request } = context;

  try {
    const openaiReq = await request.json();

    const authHeader = request.headers.get('Authorization') || '';
    const apiKey = authHeader.replace('Bearer ', '').trim();

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing API Key' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const model = openaiReq.model || 'gemini-2.0-flash';
    const isStream = openaiReq.stream || false;

    const contents = [];
    let systemInstruction = '';
    for (const msg of openaiReq.messages || []) {
      if (msg.role === 'system') {
        systemInstruction = msg.content;
        continue;
      }
      const role = msg.role === 'assistant' ? 'model' : 'user';
      contents.push({ role, parts: [{ text: msg.content }] });
    }

    const endpoint = isStream ? 'streamGenerateContent' : 'generateContent';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}?key=${apiKey}&alt=${isStream ? 'sse' : 'json'}`;

    const geminiBody = {
      contents,
      ...(systemInstruction && { systemInstruction: { parts: [{ text: systemInstruction }] } }),
      generationConfig: {
        ...(openaiReq.temperature !== undefined && { temperature: openaiReq.temperature }),
        ...(openaiReq.max_tokens !== undefined && { maxOutputTokens: openaiReq.max_tokens }),
        ...(openaiReq.top_p !== undefined && { topP: openaiReq.top_p }),
      },
    };

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });

    if (!isStream) {
      if (!geminiRes.ok) {
        const err = await geminiRes.text();
        return new Response(err, { status: geminiRes.status });
      }
      const data = await geminiRes.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return new Response(JSON.stringify({
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(geminiRes.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// 健康检查
export async function onRequestGet() {
  return new Response(JSON.stringify({ message: 'OK' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
