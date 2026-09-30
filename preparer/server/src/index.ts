import 'dotenv/config';
import { startServer } from './app.js';

// Command line: `npm start -w server` (the web deployment and development).
startServer({ port: Number(process.env.PORT || 3002), host: process.env.HOST || '0.0.0.0' }).then(({ port }) => {
  console.log(`Tax API server running on http://127.0.0.1:${port}`);
});
