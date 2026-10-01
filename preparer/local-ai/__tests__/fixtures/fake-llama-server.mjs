// A stand-in for llama.cpp llama-server in the ModelRuntime tests: parses the
// same arguments, answers /health, and answers chat completions with the name
// of the weights file it was started with (after a short delay).
import { createServer } from 'node:http';
import { basename } from 'node:path';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const port = Number(arg('--port'));
const model = basename(arg('-m'));
let active = 0;
let maxActive = 0;

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const request = JSON.parse(body);
    setTimeout(() => {
      active -= 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ model, maxActive, schema: request.response_format?.json_schema?.name }) } }] }));
    }, 120);
  });
}).listen(port, '127.0.0.1');
