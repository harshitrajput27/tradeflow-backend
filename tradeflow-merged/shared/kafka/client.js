const { Kafka, Partitioners } = require('kafkajs');

const TOPICS = {
  MARKET_DATA:       'market-data',
  ORDER_EVENTS:      'order-events',
  PORTFOLIO_UPDATES: 'portfolio-updates',
  NOTIFICATIONS:     'notifications',
  TRADE_EXECUTED:    'trade-executed',
};

function createKafkaClient(clientId) {
  const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
  return new Kafka({
    clientId,
    brokers,
    retry: { initialRetryTime: 300, retries: 8 },
  });
}

async function createProducer(clientId) {
  const kafka = createKafkaClient(clientId);
  const producer = kafka.producer({
    createPartitioner: Partitioners.LegacyPartitioner,
  });
  await producer.connect();
  console.log(`[Kafka] Producer connected — ${clientId}`);
  return producer;
}

async function createConsumer(clientId, groupId, topics, handler) {
  const kafka = createKafkaClient(clientId);
  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  for (const topic of topics) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const value = JSON.parse(message.value.toString());
        await handler(topic, value, { partition, offset: message.offset });
      } catch (err) {
        console.error(`[Kafka] Error processing message from ${topic}:`, err.message);
      }
    },
  });
  console.log(`[Kafka] Consumer connected — ${clientId} | topics: ${topics.join(', ')}`);
  return consumer;
}

async function publishMessage(producer, topic, key, value) {
  await producer.send({
    topic,
    messages: [{
      key: String(key),
      value: JSON.stringify({ ...value, _ts: Date.now() }),
    }],
  });
}

module.exports = { createKafkaClient, createProducer, createConsumer, publishMessage, TOPICS };
