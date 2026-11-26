const http = require('http');

// Simple 1x1 or small valid PNG base64 (Red-to-blue gradient style 100x100)
// Minimal valid PNG base64:
const samplePngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAALEwAACxMBAJqcGAAAADh0RVh0U29mdHdhcmUAbWF0cGxvdGxpYiB2ZXJzaW9uIDMuMS4zLCBodHRwOi8vbWF0cGxvdGxpYi5vcmcv+tBafQAAIABJREFUeJzs';

// Valid 1x1 blue PNG
const validPngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAEeQHzk4R35wAAAABJRU5ErkJggg==';

const payload = JSON.stringify({
  assetName: 'Unity_Live_Test_Banner',
  fileName: `Unity_Live_Test_Banner_${Date.now()}.png`,
  imageData: validPngBase64,
  category: 1, // DataType.Image
  playlistName: 'Occasions',
  loadImmediately: true,
  projectData: {
    title: 'Unity Live Test Banner',
    width: 1920,
    height: 1080
  },
  width: 1920,
  height: 1080
});

const req = http.request(
  {
    hostname: '127.0.0.1',
    port: 9000,
    path: '/api/assets/upload',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  },
  (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      console.log('STATUS:', res.statusCode);
      console.log('RESPONSE:', body);
    });
  }
);

req.on('error', (err) => {
  console.error('Request error:', err.message);
});

req.write(payload);
req.end();
