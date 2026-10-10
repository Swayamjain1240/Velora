'use strict';

const mongoose = require('mongoose');

async function connectDb(uri, logger) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
  });
  if (logger) logger.info('MongoDB connected');
  return mongoose.connection;
}

async function disconnectDb() {
  await mongoose.disconnect();
}

module.exports = { connectDb, disconnectDb };
