const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// MIME types mapping
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.jsx': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Simple TypeScript/JSX transformer (basic)
function transformTypeScript(content, filePath) {
  // Very basic transformation - in production you'd use esbuild or similar
  let transformed = content;
  
  // Basic JSX transformation
  transformed = transformed.replace(/import\s+.*?from\s+['"]react['"];?\s*/g, '');
  transformed = transformed.replace(/import\s+.*?from\s+['"]react-dom\/client['"];?\s*/g, '');
  
  // Add React imports at the top
  transformed = `
import { createElement as h, Fragment } from 'https://esm.sh/react@18';
import { createRoot } from 'https://esm.sh/react-dom@18/client';
const React = { createElement: h, Fragment };
${transformed}
  `;
  
  // Basic JSX transformation
  transformed = transformed.replace(/<(\w+)([^>]*)>/g, 'h("$1", {$2},');
  transformed = transformed.replace(/<\/\w+>/g, ')');
  
  return transformed;
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let filePath = path.join(__dirname, 'playground', 'src', parsedUrl.pathname);
  
  // Default to index.html
  if (parsedUrl.pathname === '/') {
    filePath = path.join(__dirname, 'playground', 'src', 'index.html');
  }
  
  // Handle file extension
  let ext = path.extname(filePath);
  
  // Check if file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
    
    // Read file
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server error');
        return;
      }
      
      let content = data;
      let contentType = mimeTypes[ext] || 'text/plain';
      
      // Transform TypeScript/JSX files
      if (ext === '.tsx' || ext === '.ts' || ext === '.jsx') {
        contentType = 'application/javascript';
        content = transformTypeScript(data.toString(), filePath);
      }
      
      // Add CORS headers for development
      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      
      res.end(content);
    });
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Development server running at http://localhost:${PORT}`);
  console.log(`📱 Test mobile responsiveness by opening in mobile browser or using dev tools device simulation`);
  console.log(`\n✨ Mobile features implemented:`);
  console.log(`   • Overlay sidebar on mobile devices`);
  console.log(`   • Hamburger menu for mobile navigation`);
  console.log(`   • Touch-friendly button sizes (44px minimum)`);
  console.log(`   • Responsive typography and spacing`);
  console.log(`   • Improved viewport handling for mobile`);
  console.log(`   • Better scrolling and touch interactions`);
  console.log(`   • Dark mode and accessibility support`);
});