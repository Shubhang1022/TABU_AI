const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;

let cached = global._mongoCache || { conn: null, promise: null, Session: null };
global._mongoCache = cached;

const messageSchema = new mongoose.Schema({
  role:      { type: String, enum: ['user', 'assistant'], required: true },
  content:   { type: String, required: true },
  type:      { type: String, default: 'text' },
  timestamp: { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  userId:    { type: String, required: true, index: true },
  title:     { type: String, default: 'New Chat' },
  messages:  [messageSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

async function connectDB() {
  if (cached.conn) return cached;

  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      bufferCommands: false
    }).then(m => m);
  }

  cached.conn = await cached.promise;
  cached.Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
  return cached;
}

module.exports = { connectDB };
