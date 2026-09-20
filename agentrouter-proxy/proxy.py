import asyncio
import sys
from anthropic import AsyncAnthropic
from aiohttp import web
import json

async def proxy_handler(request):
    try:
        body = await request.json()
        auth = request.headers.get('Authorization', '').replace('Bearer ', '')
ECHO is off.
        if not auth:
            return web.json_response({'error': 'No API key'}, status=401)
ECHO is off.
        client = AsyncAnthropic(
            api_key=auth,
            base_url='https://agentrouter.org'
        )
ECHO is off.
        messages = body.get('messages', [])
        model = body.get('model', 'claude-opus-4-8')
        max_tokens = body.get('max_tokens', 8192)
        stream = body.get('stream', False)
ECHO is off.
        if stream:
            response = web.StreamResponse()
            response.headers['Content-Type'] = 'text/event-stream'
            await response.prepare(request)
ECHO is off.
            async with client.messages.stream(
                model=model,
                max_tokens=max_tokens,
                messages=messages
            ) as stream:
                async for text in stream.text_stream:
                    chunk = {
                        'choices': [{'delta': {'content': text}}]
                    }
                    await response.write(
                        f'data: {json.dumps(chunk)}\n\n'.encode()
                    )
ECHO is off.
            await response.write(b'data: [DONE]\n\n')
            return response
        else:
            message = await client.messages.create(
                model=model,
                max_tokens=max_tokens,
                messages=messages
            )
ECHO is off.
            result = {
                'choices': [{
                    'message': {
                        'role': 'assistant',
                        'content': message.content[0].text
                    }
                }]
            }
            return web.json_response(result)
ECHO is off.
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)

async def health_handler(request):
    return web.json_response({'status': 'ok'})

app = web.Application()
app.router.add_post('/v1/chat/completions', proxy_handler)
app.router.add_get('/health', health_handler)

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f'Starting AgentRouter proxy on port {port}...')
    web.run_app(app, host='127.0.0.1', port=port)
