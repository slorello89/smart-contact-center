const express = require('express');
const bluebird = require('bluebird');
const bodyParser = require('body-parser');
const Nexmo = require('nexmo');
const path = require('path');
const redis = bluebird.promisifyAll(require('redis'));
const http = require('http')
const requestLib = require('request')
var os = require('os');
const { text } = require('body-parser');
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

redisClient.set("Channels:whatsapp",process.env.WHATSAPP_PROXY_NUMBER)
redisClient.set("Channels:sms", process.env.NEXMO_NUMBER)
redisClient.set("Channels:voice", process.env.NEXMO_NUMBER)
redisClient.set("Channels:viber_service_msg", process.env.VIBER_PROXY_NUMBER)
redisClient.set("Channels:messenger", process.env.MESSENGER_PROXY)

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

app.route('/webhooks/answer').get(handleAnswer);

app.route('/webhooks/asr-init').post(handleAsrInit);

app.route('/webhooks/asr').post(handleAsr);

app.route('/webhooks/events').post(handleEvent);

app.route('/addAgent').post(addAgent);

app.route('/getAgents').get(getAgents);

app.route('/getCustomers').get(getCustomers);

function handleEvent(request, response){
  response.status(204).send();
}

function handleAsr(request, response){
  response.status(204).send();
}

function handleAsrInit(request, response){  
  const params = Object.assign(request.query, request.body);
  console.log(params);
  let fromNumber = params['uuid'];
  let msgText = params['speech']['results'][0].text;
  let channel = 'voice';
  let toNumber = params['toNumber'];
  let customerInfo = {from:fromNumber, to:toNumber, msgText:msgText, channel:channel}

  handleAnalyze(msgText,postAnalyze,customerInfo);
  let ncco = [
    {
      action: 'talk',
      text: 'Please wait to be connected to an agent'
    },
    {
      action: 'conversation',
      name: params['uuid']
    }]
  response.json(ncco);
}

function handleAnswer(request, response){
  const params = Object.assign(request.query, request.body);
  console.log(params);
  const ncco = [{
    action: 'talk',
    text: 'Hello, welcome to the customer service hotline - can you please provide a brief description of what you need?',
  },
  {
    action: 'input',
    eventUrl: [`${request.protocol}://${request.get('host')}/webhooks/asr-init?fromNumber=${params['from']}&toNumber=${params['to']}`],
    speech: {
      endOnSilence: 1,
      language: "en-US",
      uuid: [request.query.uuid]
    }
  }
  ]
  response.json(ncco)
}

function addAgent(request, response) {
  let agentName = request.body['agentName'];
  let agentNumber = request.body['agentNum'];
  let agentChannel = request.body['agentChannel'];
  let agentSpecialty = request.body['specialty']
  let availability = 'unavailable';  
  redisClient.hmset(
    'agents:' + agentNumber,
    'agentName',
    agentName,
    'availability',
    availability,
    'agentNumber',
    agentNumber,
    'agentChannel',
    agentChannel,
    'specialty',
    agentSpecialty, 
    function(err, res){
      if(agentChannel == 'voice')
        handleSignIn(agentNumber,'','voice');
    }
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

async function getCustomerChannel(customerNumber){
  ret = {}
  await redisClient
    .hgetallAsync('customers:'+customerNumber)
    .then(function(customer){
      ret = customer;
    })
    .catch(function(e){
      console.log(e)
    });
  return ret['channel'];
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
          channel: agent['agentChannel'],
          specialty: agent['specialty']
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
          channel: customer['channel'],
          specialty: customer['specialty']
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
  const params = Object.assign(request.query, request.body);
  console.log(params);
  response.status(204).send();
  var body = request.body;
  let fromNumber = body['from']['number'];  
  let toNumber = body['to']['number'];
  if(!fromNumber){
    fromNumber= body['from']['id']    
  }
  if(!toNumber){
    toNumber= body['to']['id']
  }
  let channel = body['from']['type'];
  let msgText = body['message']['content']['text'];  
  redisClient.hgetall('agents:' + fromNumber, (err, agent) => {
    if (err) {
      console.log(err);
    } else {
      if (agent) {
        handleInboundFromAgent(msgText, toNumber, fromNumber, channel);
      } else {
        
        handleInboundFromCustomer(fromNumber, toNumber, channel, msgText);
      }
    }
  });  
}

function handleInboundSms(request, response){
  response.status(204).send();
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
        handleInboundFromAgent(msgText,toNumber,fromNumber,channel)

      } else{
        handleInboundFromCustomer(fromNumber, toNumber, channel, msgText);
      }
    }
  })

  const params = Object.assign(request.query, request.body);
  console.log(params);
}

function postAnalyze(topIntent, customerInfo){  
  message = {type:'text', text:'Could you provide a brief description of what you need?'}
  fromNumber = customerInfo['from'];
  toNumber = customerInfo['to'];
  channel = customerInfo['channel']
  msgText = customerInfo['msgText']
  if(topIntent['name'] =='sys.default'){    
    sendMessage('', fromNumber, message, channel)
  }
  else{
    redisClient.spop('available_'+topIntent['name'], async(err,reply)=>{
      if(err){
        console.log(err);
      }
      else{        
        if(reply){
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
            channel,
            'specialty',
            topIntent['name']
          );
          redisClient.sadd(agentNumber + CUSTOMERS, fromNumber);
          redisClient.set(reply, fromNumber);
          console.log('***REPLY**: ' + reply);
          message['text'] =
            emoji + ' - ' + msgText;
          let agentChannel = await getAgentChannel(agentNumber)
          if(agentChannel == 'voice' && channel == "voice" ){
            client = new Nexmo(
              {
                apiKey: process.env.NEXMO_API_KEY,
                apiSecret: process.env.NEXMO_API_SECRET,
                applicationId: process.env.NEXMO_APPLICATION_ID,
                privateKey: Buffer.from(
                  process.env.NEXMO_APPLICATION_PRIVATE_KEY.replace(/\\n/g, '\n'),
                  'utf-8'
                ),
              },      
            );
            client.calls.create({
              to: [{
                type: 'phone',
                number: agentNumber
              }],
              from: {
                type: 'phone',
                number: process.env.NEXMO_NUMBER
              },
              ncco: [{
                "action": "conversation",
                "name": fromNumber
              }]
            }, (error, response) => {
              if (error) console.error(error)
              if (response) console.log(response)
            })
            // nexmo.calls.update(fromNumber,{
            //   action: 'transfer',
            //   destination: {
            //     'type':'ncco',
            //     'ncco' : [
            //       {
            //         action:'connect',
            //         from: process.env.NEXMO_NUMBER,
            //         endpoint: [{
            //           type:'phone',
            //           number: agentNumber
            //         }]
            //       }
            //     ]
            //   }
            // });
          }
          else{
            sendMessage(
              toNumber,
              agentNumber,
              message,
              agentChannel
            );
          }
          
        }else {
          message['text'] = "We're sorry, no agents are available at this time. Please try again later";
          sendMessage(toNumber, fromNumber, message, channel);
        }
      }
    });
  }
}
/**
 * Creates a customer if we don't already have a record for the incoming number.
 * Sends the customer's message to the agent with prepended emoji
 * @param {Body of the incoming http message to the webhook} messageBody string
 */
function handleInboundFromCustomer(fromNumber, toNumber, channel, msgText) {
  let content = {type:'text',text:msgText};
  let agentNumber = '';
  let emoji = '';
  redisClient.hgetall('customers:' + fromNumber, async (err, user) => {
    if (err) {
      console.log(err);
    } else {
      if (!user || user['agent'] == '') {
        handleAnalyze(msgText,postAnalyze,{from:fromNumber,to:toNumber, msgText:msgText, channel:channel})
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
function handleInboundFromAgent(msgText, to, from, channel) {  
  let message = {
    type: 'text',
    text: msgText,
  };
  if (msgText.toLowerCase().indexOf('sign in') >= 0) {
    handleSignIn(from, to, channel);
  } else if (msgText.toLowerCase().indexOf('sign out') >= 0) {
    handleSignOut(from, to, channel);
  } else {
    var charPoint = parseInt(msgText.codePointAt(0).toString('16'), 16);
    var emoji = String.fromCodePoint(charPoint);

    message['text'] = msgText.substring(2).trim();
    redisClient.get(from + emoji, async (err, number) => {
      if (err) {
        console.log(err);
      } else {
        // check if agent is associated with the emoji in question, tell them to check their emoji if not
        if (number) {
          customerChannel = await getCustomerChannel(number)
          sendMessage(to, number, message, customerChannel);
        } else {
          console.log('number not found for ' + emoji);
          message = {
            type: 'text',
            text:
              'please check your message has the correct emoji at the start',
          };
          sendMessage(to, from, message, channel);
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
function handleSignIn(agentNumber, proxyNumber, channel) {  
  let message = {
    type: 'text',
    text: 'something went wrong while signing you in',
  };
  redisClient.hgetall('agents:' + agentNumber, (err, reply) => {
    if (err) {
      console.log(err);
    } else {
      if (channel == 'voice'){
        redisClient.sadd('available_'+reply['specialty'], agentNumber+emojis[0]);
        redisClient.hset('agents:' + agentNumber, 'availability', 'available');
        return;
      }
      if (!reply || reply['availability'] == 'unavailable') {
        emojis.forEach((entry) => {
          redisClient.sadd('available_'+reply['specialty'], agentNumber + entry);
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
    sendMessage(proxyNumber, agentNumber, message, channel);
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
  sendMessage(from, agentNumber, message, channel);
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
  let client = nexmo;
  if (channel == 'sms' || channel =='voice' )
  {
    client = new Nexmo(
      {
        apiKey: process.env.NEXMO_API_KEY,
        apiSecret: process.env.NEXMO_API_SECRET,
        applicationId: process.env.NEXMO_APPLICATION_ID,
        privateKey: Buffer.from(
          process.env.NEXMO_APPLICATION_PRIVATE_KEY.replace(/\\n/g, '\n'),
          'utf-8'
        ),
      },      
    );
  }
  redisClient.get("Channels:"+channel,(err, proxy)=>{
    if(err){
      console.log(err);
    }
    else{
      if(channel == 'whatsapp' || channel == 'sms' ){
        client.channel.send(
          { type: channel, number: to },
          { type: channel, number: proxy },
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
      else if(channel=='viber_service_msg'){
        client.channel.send(
          { type: channel, number: to },
          { type: channel, id: proxy },
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
      else if (channel == 'voice'){
        let transferNcco = [{
          action: 'talk',
          text: message['text']
          }];
        if (message['text'] != "We're sorry, no agents are available at this time. Please try again later"){
          transferNcco.push({
            action: 'input',
            eventUrl: [`${process.env.SCHEME}://${process.env.HOST}/webhooks/asr`],
            speech:{
              endOnSilence: 1,
              language: "en-US",
              uuid:to
            }
          });
        }
        client.calls.update(to,{
          action:'transfer',
          destination: {
            type:'ncco',
            ncco: transferNcco
          }
        })        
      }
      else{
        client.channel.send(
          { type: channel, id: to },
          { type: channel, id: proxy },
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
    }
  })  
}

function handleStatus(request, response) {
  const params = Object.assign(request.query, request.body);
  console.log(params);
  response.status(204).send();
}

function handleAnalyze(text, callback, customerInfo){
  let req_body = {
    model_id:process.env.MODEL_ID,
    text:text,
    language_code: "en-US"
  }
  var username = process.env.NEXMO_API_KEY;
  var password = process.env.NEXMO_API_SECRET;
  var auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  options = {
    host: process.env.OVERAI_HOST,
    path: '/analyze',
    method:'POST',
    headers:{'x-original-client-ip-address':getIpAddress(), 'Authorization': auth}
    }
  let req = http.request(options,onAnalyze);
  req.write(JSON.stringify(req_body));
  req.on('response', response=>{
    response.on('data',data=>{
      var r = JSON.parse(data)
      console.log(r['intents'][0]);
      callback(r['intents'][0], customerInfo);
    })
    console.log(response);
  })
  req.end();  
}

function onAnalyze(response){
  var str = ''
  response.on('data', function (chunk) {
    str += chunk;
  });

  response.on('end', function () {
    console.log(str);
  });
}

function getIpAddress(){
  var address,
    ifaces = require('os').networkInterfaces();
    for (var dev in ifaces) {
        ifaces[dev].filter((details) => details.family === 'IPv4' && details.internal === false ? address = details.address: undefined);
    }
  return address
}
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
