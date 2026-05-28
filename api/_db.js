const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI;
const DB_NAME = 'tabuai';

let cached = global._mongoClient || { client: null, promise: null };
global._mongoClient = cached;

async function connectDB() {
  if (cached.client) {
    return cached.client.db(DB_NAME).collection('sessions');
  }
  if (!cached.promise) {
    cached.promise = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000
    }).connect();
  }
  cached.client = await cached.promise;
  return cached.client.db(DB_NAME).collection('sessions');
}

module.exports = { connectDB };
