const express = require('express');
const bluebird = require('bluebird');
const bodyParser = require('body-parser');
const Nexmo = require('nexmo');
const path = require('path');
const redis = bluebird.promisifyAll(require('redis'));
require('dotenv').config();
const PORT = process.env.PORT || 5001;
const redisClient = bluebird.promisifyAll(
  redis.createClient(process.env.REDIS_URL)
);
const nexmo = new Nexmo(
  {
    apiKey: process.env.NEXMO_API_KEY,
    apiSecret: process.env.NEXMO_API_SECRET,
    applicationId: process.env.NEXMO_APPLICATION_ID,
    privateKey: Buffer.from(
      process.env.NEXMO_APPLICATION_PRIVATE_KEY.replace(/\\n/g, '\n'),
      'utf-8'
    ),
  },
  {
    apiHost: 'messages-sandbox.nexmo.com',
  }
);

const CUSTOMERS = '_customers';

const emojis = ['🏠', '🍎', '🥑', '🌳', '🎪', '🌈'];

const app = express();

app
  .use(express.static(path.join(__dirname, 'public')))
  .use(bodyParser.json())
  .use(bodyParser.urlencoded({ extended: true }))
  .set('views', path.join(__dirname, 'views'))
  .set('view engine', 'ejs')
  .get('/', (req, res) => res.render('pages/index'));

app.route('/webhooks/inbound').get(handleInbound).post(handleInbound);

app.route('/webhooks/inbound-wa').get(handleInbound).post(handleInbound);

app.route('/webhooks/status').get(handleStatus).post(handleStatus);

app.route('/webhooks/msg-event').get(handleStatus).post(handleStatus);

app.route('/webhooks/inbound-sms').get(handleInboundSms).post(handleInboundSms);

app.route('/addAgent').post(addAgent);

app.route('/getAgents').get(getAgents);

app.route('/getCustomers').get(getCustomers);

function addAgent(request, response) {
  let agentName = request.body['agentName'];
  let agentNumber = request.body['agentNum'];
  let agentChannel = request.body['agentChannel'];
  redisClient.hmset(
    'agents:' + agentNumber,
    'agentName',
    agentName,
    'availability',
    'unavailable',
    'agentNumber',
    agentNumber,
    'agentChannel',
    agentChannel
  );
  const params = Object.assign(request.query, request.body);
  console.log(params);
  response.status(200).redirect('/');
}
async function getAgentChannel(agentNum){
  ret = {}
  await redisClient
    .hgetallAsync('agents:'+agentNum)
    .then(function(agent){
      ret = agent;
    })
    .catch(function(e){
      console.log(e)
    });
  return ret['agentChannel'];
}
async function getAgents(request, response) {
  let ret = [];
  let agents = [];

  await redisClient
    .keysAsync('agents:*')
    .then(function (theAgents) {
      agents = theAgents;
    })
    .catch(function (e) {
      console.log(e);
    });

  for (i = 0; i < agents.length; i++) {
    entry = agents[i];
    await redisClient
      .hgetallAsync(entry)
      .then(function (agent) {
        ret.push({
          name: agent['agentName'],
          availability: agent['availability'],
          number: agent['agentNumber'].replace(/.(?=.{3,}$)/g, '*'),
          channel: agent['agentChannel']
        });
      })
      .catch(function (e) {
        console.log(e);
      });
  }
  response.json(ret);
}

async function getCustomers(req, resp) {
  let ret = [];
  let customers = [];
  await redisClient
    .keysAsync('customers:*')
    .then(function (theCustomers) {
      customers = theCustomers;
    })
    .catch(function (e) {
      console.log(e);
    });

  for (i = 0; i < customers.length; i++) {
    entry = customers[i];
    await redisClient.hgetallAsync(entry).then(function (customer) {
      if (customer['agentNum'] != '') {
        ret.push({
          assignedAgentNum: customer['agentNum'].replace(/.(?=.{3,}$)/g, '*'),
          emoji: customer['emoji'],
          customerNumber: entry.split(':')[1].replace(/.(?=.{3,}$)/g, '*'),
          channel: customer['channel']
        });
      }
    });
  }
  resp.json(ret);
}
/**
 * This looks to see if there is already a user record for the from number
 * if not - create a new Customer user object (consequentially agents must be pre-seeded)
 * if a user exists for that number check if it's a customer or agent and handle appropriately
 * @param {http request from the webhook} request
 * @param {response to be sent back to the webhook} response
 */
function handleInbound(request, response) {
  var body = request.body;
  let fromNumber = body['from']['number'];
  redisClient.hgetall('agents:' + fromNumber, (err, agent) => {
    if (err) {
      console.log(err);
    } else {
      if (agent) {
        handleInboundFromAgent(body);
      } else {
        let fromNumber = body['from']['number'];
        let toNumber = body['to']['number'];
        let channel = body['from']['type'];
        let msgText = body['message']['content']['text'];
        handleInboundFromCustomer(fromNumber, toNumber, channel, msgText);
      }
    }
  });
  const params = Object.assign(request.query, request.body);
  console.log(params);
  response.status(204).send();
}

function handleInboundSms(messageBody){
  var body = request.body;
  let fromNumber = body['msisdn'];
  let toNumber = body['to'];
  let channel = 'sms';
  let msgText = body['text'];
  redisClient.hgetall('agents:' + fromNumber, (err,agent)=>{
    if(err){
      console.log(err);
    }
    else{
      if(agent){

      } else{
        handleInboundFromCustomer(fromNumber, toNumber, channel, msgText);
      }
    }
  })

  const params = Object.assign(request.query, request.body);
  console.log(params);
  response.status(204).send();

}

/**
 * Creates a customer if we don't already have a record for the incoming number.
 * Sends the customer's message to the agent with prepended emoji
 * @param {Body of the incoming http message to the webhook} messageBody string
 */
async function handleInboundFromCustomer(fromNumber, toNumber, channel, msgText) {
  // let fromNumber = messageBody['from']['number'];
  // let toNumber = messageBody['to']['number'];
  // let channel = messageBody['from']['type'];
  let content = {type:'text',text:msgText};
  let agentNumber = '';
  let emoji = '';
  redisClient.hgetall('customers:' + fromNumber, async (err, user) => {
    if (err) {
      console.log(err);
    } else {
      if (!user || user['agent'] == '') {
        redisClient.spop('available', async (err, reply) => {
          if (err) {
            console.log(err);
          }
          if (reply) {
            var charPoint = parseInt(
              reply.codePointAt(reply.length - 2).toString('16'),
              16
            );
            agentNumber = reply.substring(0, reply.length - 2);
            var emoji = String.fromCodePoint(charPoint);

            redisClient.hmset(
              'customers:' + fromNumber,
              'proxyNumber',
              toNumber,
              'agent',
              reply,
              'emoji',
              emoji,
              'agentNum',
              agentNumber,
              'channel',
              channel
            );
            redisClient.sadd(agentNumber + CUSTOMERS, fromNumber);
            redisClient.set(reply, fromNumber);
            console.log('***REPLY**: ' + reply);
            content['text'] =
              emoji + ' - ' + msgText;
            let agentChannel = await getAgentChannel(agentNumber)
            sendMessage(
              toNumber,
              agentNumber,
              content,
              agentChannel
            );
            
          } else {
            let message = {
              type: 'text',
              text:
                "We're sorry, no agents are available at this time. Please try again later",
            };
            sendMessage(toNumber, fromNumber, message, channel);
          }
        });
      } else {
        content['text'] =
          user['emoji'] + ' - ' + msgText;
        let agentChannel = await getAgentChannel(user['agentNum'])
        sendMessage(
          toNumber,
          user['agentNum'],
          content,
          agentChannel          
        );
      }
    }
  });
}

/**
 * This handles inbound messages from agents
 * The message is expected to be one of these formats:
 *  1:'<emoji> message' - looks up which user has this emoji and forwards the msg
 *  2:'sign in' - calls signIn
 *  3:'sign out' - calls signOut
 * @param {this is the body from the inbound whatsApp message} messageBody
 */
function handleInboundFromAgent(messageBody, msgText, to, from, channel) {
  let msgText = messageBody['message']['content']['text'];
  if (msgText.toLowerCase().indexOf('sign in') >= 0) {
    handleSignIn(messageBody['from']['number'], messageBody['to']['number']);
  } else if (msgText.toLowerCase().indexOf('sign out') >= 0) {
    handleSignOut(messageBody['from']['number'], messageBody['to']['number']);
  } else {
    var charPoint = parseInt(msgText.codePointAt(0).toString('16'), 16);
    var emoji = String.fromCodePoint(charPoint);

    messageBody['message']['content']['text'] = messageBody['message'][
      'content'
    ]['text']
      .substring(2)
      .trim();
    redisClient.get(messageBody['from']['number'] + emoji, (err, number) => {
      if (err) {
        console.log(err);
      } else {
        // check if agent is associated with the emoji in question, tell them to check their emoji if not
        if (number) {
          sendMessage(
            messageBody['to']['number'],
            number,
            messageBody['message']['content']
          );
        } else {
          console.log('number not found for ' + emoji);
          var message = {
            type: 'text',
            text:
              'please check your message has the correct emoji at the start',
          };
          sendMessage(
            messageBody['to']['number'],
            messageBody['from']['number'],
            message
          );
          return;
        }
      }
    });
  }
}

/*
Checks if agent is already available, if they are, then it tells the agent they've 
already signed in, if not it sets agent's status to available
*/
function handleSignIn(agentNumber, proxyNumber) {
  let message = {
    type: 'text',
    text: 'something went wrong while signing you in',
  };
  redisClient.hgetall('agents:' + agentNumber, (err, reply) => {
    if (err) {
      console.log(err);
    } else {
      if (!reply || reply['availability'] == 'unavailable') {
        emojis.forEach((entry) => {
          redisClient.sadd('available', agentNumber + entry);
        });
        redisClient.hset('agents:' + agentNumber, 'availability', 'available');
        message = {
          type: 'text',
          text:
            'You have been signed in. Reply to customers using their emoji prefix at the start of your message',
        };
      } else {
        message = { type: 'text', text: 'You were already signed in' };
      }
    }
    sendMessage(proxyNumber, agentNumber, message);
  });
}

function handleSignOut(agentNumber, from) {
  emojis.forEach((entry) => {
    redisClient.srem('available', 1, agentNumber + entry);
  });
  redisClient.hset('agents:' + agentNumber, 'availability', 'unavailable');

  redisClient.smembers(agentNumber + CUSTOMERS, (err, reply) => {
    if (err) {
      console.log(err);
    } else {
      reply.forEach((entry) => {
        reassignAgent(entry);
      });
      redisClient.del(agentNumber + CUSTOMERS);
    }
  });

  message = {
    type: 'text',
    text: 'You have been signed out. Thanks for your hard work!',
  };
  sendMessage(from, agentNumber, message);
}

function reassignAgent(customerNumber) {
  redisClient.spop('available', (err, reply) => {
    if (err) {
      console.log(err);
    } else if (reply) {
      var charPoint = parseInt(
        reply.codePointAt(reply.length - 2).toString('16'),
        16
      );
      agentNumber = reply.substring(0, reply.length - 2);
      var emoji = String.fromCodePoint(charPoint);
      redisClient.hmset(
        'customers:' + customerNumber,
        'agent',
        reply,
        'emoji',
        emoji,
        'agentNum',
        agentNumber
      );
      redisClient.sadd(agentNumber + CUSTOMERS, customerNumber);
      redisClient.set(reply, customerNumber);
      redisClient.hgetall('customers:' + customerNumber, (err, user) => {
        if (err) {
          console.log(err);
        } else {
          proxyNumber = user['proxyNumber'];
          let body = {
            type: 'text',
            text: emoji + ' - You have been assigned a new case',
          };
          sendMessage(proxyNumber, agentNumber, body);
        }
      });
    } else {
      redisClient.hmset(
        'customers:' + customerNumber,
        'agent',
        '',
        'emoji',
        '',
        'agentNum',
        ''
      );
      let body = {
        type: 'text',
        text:
          "We're sorry, there are no available agents at this time, please try again later",
      };
      redisClient.hgetall('customers:' + customerNumber, (err, user) => {
        if (err) {
          console.log(err);
        } else {
          proxyNumber = user['proxyNumber'];
          sendMessage(proxyNumber, customerNumber, body);
        }
      });
    }
  });
}

function sendMessage(from, to, message, channel='whatsapp') {
  nexmo.channel.send(
    { type: channel, number: to },
    { type: channel, number: from },
    {
      content: message,
    },
    (err, data) => {
      if (err) {
        console.error(err);
      } else {
        console.log(data.message_uuid);
      }
    }
  );
}

function handleStatus(request, response) {
  const params = Object.assign(request.query, request.body);
  console.log(params);
  response.status(204).send();
}
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
