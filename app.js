var mongoose = require('mongoose'),
    bodyParser = require('body-parser'),
    async = require("async"),
    map = require('array-map'),
    app = require('express')(),
    fs = require('fs'),
    open = require('open'),
    swig  = require('swig'),
    https = require('https'),
    http = require('http'),
    apn = require('apn');

var options = {
  production: false,
  cert: 'certs/dev_cert.pem',
  key: 'certs/dev_key.pem',
  voip: true
};
var apnConnection = new apn.Connection(options);
apnConnection.on("connected", function() {
    console.log("apn connected");
});
apnConnection.on("transmitted", function(notification, device) {
    console.log("apn sent");
});
apnConnection.on("transmissionError", function(errCode, notification, device) {
    console.error("apn error: " + errCode + " for device ", device, notification);
    if (errCode === 8) {
        console.log("apn error: invalid device token, are you using the correct environment? production vs. sandbox");
    }
});
apnConnection.on("timeout", function () {
    console.log("apn connection timeout");
});
apnConnection.on("disconnected", function() {
    console.log("apn disconnected");
});
apnConnection.on("socketError", console.error);

// const  APNS = require('apns2');
// var client = new APNS({
//   host: 'api.development.push.apple.com', // dev
//   // host: 'api.push.apple.com',          // prod
//   port: 443,
//   cert: fs.readFileSync(`${__dirname}/voip/cert.pem`),
//   key: fs.readFileSync(`${__dirname}/voip/key.pem`)
// });

var Schema = mongoose.Schema;

Phone = mongoose.model('Phone', new Schema({
  _id : String,
  device : { type: String, index: true },
  contacts: { type: Object },
}, { timestamps: { createdAt: 'created', updatedAt: 'updated' } }));

Contact = mongoose.model('Contact', {
  _id : String,
  contacts: Array,
});

mongoose.connect(process.env.MONGODB_URI, function (error) {
    if (error) console.error(error);
    else console.log('mongo connected');
});

var serverPort = (process.env.PORT || 4443);
var server;

if (process.env.LOCAL) {
  var options = {
      key: fs.readFileSync('./fake-keys/privatekey.pem'),
      cert: fs.readFileSync('./fake-keys/certificate.pem')
  };
  server = https.createServer(options, app);
} else {
  server = http.createServer(app);
}

var io = require('socket.io')(server);

// Mapping phone number to socket id
var connectedPhones = {}
// Mapping phone number to device token
var devices = {}

// app.get('/:room', function (req, res) {
//     var tmpl = swig.compileFile(__dirname + '/index.html'),
//         renderedHtml = tmpl({
//             room: req.params.room
//         });
//     res.writeHead(200, {
//         'Content-Type': 'text/html'
//     });
//     res.end(renderedHtml);
// });

server.listen(serverPort, function () {
    console.log('server up and running at %s port', serverPort);
    if (process.env.LOCAL) {
        open('https://localhost:' + serverPort)
    }
});

io.on('connection', function (socket) {

    // console.log("connected", socket.id);

    socket.on('auth', function(number, callback){

      if (!number || number == 'undefined' || number.length < 9 || number.length > 15){
        console.log("invalid phone number: ", number);
        return;
      }

      socket.number = number;
      connectedPhones[number] = socket;

      log("auth");

      // check if we have new phone number
      // if so create new phone and save to db
      // else update new socket id for that phone
      Phone.findById(number, function ( err, phone ) {
        if (err) {
          log(err);
        } else {
          if (phone){
            // cache device token to memory
            socket.device = phone.device;
            devices[number] = phone.device;
            callback(phone);
          } else{
            phone = new Phone({ _id: number });
            phone.save(function (err, phone) {
              if (err) log(err);
              else log('added phone');
              callback(phone);
            });
          }
        }
      });
    });

    socket.on('device', function (device) {
      log('device');

      // cache device token to memory
      socket.device = device;
      devices[socket.number] = device;

      // save device token to db
      Phone.findById(socket.number, function(err, phone){
        phone.device = device;
        phone.save(function(err, phone){
          if (err) log(err);
          else log('save device --> %s', phone.device);
        });
      });
    });

    socket.on('contacts', function (contacts) {
      log('contacts');
      Phone.findById(socket.number, function(err, phone){
        phone.contacts = contacts;
        phone.save(function(err, phone){
          if (err) log(err);
          else log('save contacts --> %s', Object.keys(contacts).length);
        });
      });
    });

    socket.on('disconnect', function () {
      log('disconnected');
      delete connectedPhones[socket.number];
      if (socket.room) {
          io.to(socket.room).emit('hangup', socket.id);
          socket.leave(socket.room);
          socket.room = null;
      }
    });

    socket.on('leave', function () {
      var room = socket.room;
      if (room) {
        socket.leave(room);
        socket.room = null;
      }
      log('leave room', room);
    });

    socket.on('hangup', function () {
      var room = socket.room;
      if (room) {
        socket.leave(room);
        io.to(room).emit('hangup', socket.id);
      }
      socket.room = null;
      log('hangup, leave room', room);
    });

    socket.on('join', function (room, callback) {
      if (socket.room == room){
        log('current room', room);
        callback();
      } else {
        var socketIds = socketIdsInRoom(room);
        if (socketIds.length == 0){
          log('room empty', room);
          callback(socketIds);
        }
        else {
          log('join room --> %s', room);
          socket.join(room);
          socket.room = room;
          callback(socketIds);
        }
      }
    });

    socket.on('exchange', function (data) {
      log('exchange');
      data.from = socket.id;
      if (io.sockets.connected[data.to]){
        io.sockets.connected[data.to].emit('exchange', data);
      }
    });

    socket.on('ringback', function(from){
      log('ringback ---> %s', from);
      fromsocket = connectedPhones[from];
      if (fromsocket){
        fromsocket.emit('ringback', socket.number);
      }
    });

    socket.on('accept', function(from){
      log('accept ---> %s', from);
      fromsocket = connectedPhones[from];
      if (fromsocket){
        fromsocket.emit('accept', socket.number);
      }
    });

    socket.on('call', function (data, callback) {

      var room = data.room;

      if (socket.room == room){
        log('current room', room);
        callback();
        return;
      }

      var socketIds = socketIdsInRoom(room);

      // if room alredy existed simply join
      if (socketIds.length > 0){
        log('room existed, join --> %s', room);
        socket.join(room);
        socket.room = room;
        callback(socketIds);
        return;
      }

      log('calling ---> %s', data.to);
      log('create room', room);

      callback(socketIds);
      socket.join(room);
      socket.room = room;

      // check if phone online emit call
      var call = { from : socket.number, room: room };
      var tosocket = connectedPhones[data.to];
      var status = 'disconnected';
      if (tosocket){
        var status = 'connected';
        tosocket.emit('call', call);
      }

      if (devices[data.to]){
        // log('device', devices[data.to]);
        // get device token from memory if possible
        sendpush({
          // sound: 'Marimba.m4r',
          device: devices[data.to],
          data: { from: socket.number, room: room, type:'call', status: status }
        });
      } else {
        // else get device token from db
        Phone.findById(data.to, function(err, phone){
          devices[data.to] = phone.device;
          // log('*device', devices[data.to]);
          sendpush({
            // sound: 'Marimba.m4r',
            device: phone.device,
            data: { from: socket.number, room: room, type:'call', status: status }
          });
        });
      }

    });

    socket.on('sync contacts', function (contacts, contactCallback) {

      log('begin syncing %d contacts...', contacts.length);

      Contact.findById(socket.number, function(err, c){
        if (c){
          c.contacts = contacts;
        } else{
          var c = new Contact({ _id: socket.number, contacts: contacts });
        }
        c.save(function(err){
          if (err) log(err)
        });
      });

      var activeContacts = {}

      async.forEach(contacts, function(c, callback1){
        if (c.phoneNumbers.length > 10) {
          callback1()
          return;
        }

        async.forEach(c.phoneNumbers, function(p, callback2){
          var n = p.number.replace(/\s+/g, '');
          if (n.substring(0, 1) == '0'){
            n = new RegExp('.*' + n.substring(1, n.length) + '$');
          }
          var length = c.phoneNumbers.length;
          // find phone with this number
          Phone.findOne({_id:n}, function(err, phone){
            if (phone && phone._id != socket.number){
              var fullName = [c.firstName, , c.middleName, c.lastName].join(' ').trim();
              if (length > 1) fullName += ' (' + phone._id.substr(phone._id.length-4) + ')';
              ac = {
                recordID: c.recordID,
                firstName: c.firstName,
                lastName: c.lastName,
                middleName: c.middleName,
                number: phone._id,
				pnumber: p.number,
                fullName: fullName,
              }
              activeContacts[ac.number] = ac;
              log('found *** %s ***', p.number);
              callback2();
            }
            else {
              callback2();
            }
          });
        }, function(err){
          callback1();
        });
      }, function(err){
        Phone.findById(socket.number, function(err, phone){
          phone.contacts = activeContacts;
          phone.save();
        });
        contactCallback(activeContacts);
        log('done syncing %d contacts', contacts.length);
        log('found %d active contacts', Object.keys(activeContacts).length);
      });

    });

    socket.on('log', function(msg, data){
      log('-> ' + msg, data);
    });

    socket.on('pinging', function(callback){
      callback();
      log('ping');
      socket.broadcast.emit('pinging', socket.number);
    });

    var log = function(msg, data){
      if (data){
        console.log(socket.number + ' : ' + msg, data);
      } else {
        console.log(socket.number + ' :', msg);
      }
    }
});

// var ping = setInterval(function () {
//   for (var key in io.sockets.connected){
//     var startTime = Date.now();
//     io.sockets.connected[key].volatile.emit('ping', function(number){
//       var latency = Date.now() - startTime;
//       console.log(number + ' : ping %s ms', latency);
//     });
//   }
// }, 5000);

var socketIdsInRoom = function(name) {
    // var socketIds = io.nsps['/'].adapter.rooms[name];
    var room = io.sockets.adapter.rooms[name];
    return room ? Object.keys(room) : [];
}

var sendpush = function(no){
  var device = new apn.Device(no.device);
  var n = new apn.Notification();
  n.alert = no.alert;
  n.payload = no.data;
  // n.sound = no.sound;
  // n.badge = no.badge;
  // n.expiry = Math.floor(Date.now() / 1000) + 3600; // Expires 1 hour from now.
  apnConnection.pushNotification(n, device);

}

app
  .use(bodyParser.json()) // support json encoded bodies
  .use(bodyParser.urlencoded({ extended: true })) // support encoded bodies

  .get('/api/phones', function (req, res) {
    // http://mongoosejs.com/docs/api.html#query_Query-find
    Phone.find( function ( err, nodes ){
      res.status(200).json(nodes);
    });
  })

  .get('/api/contacts', function (req, res) {
    // http://mongoosejs.com/docs/api.html#query_Query-find
    Contact.find( function ( err, nodes ){
      res.status(200).json(nodes);
    });
  })

  // .post('/api/phones', function (req, res) {
  //   var phone = new Phone( req.body );
  //   phone._id = phone._id;
  //   // http://mongoosejs.com/docs/api.html#model_Model-save
  //   phone.save(function (err) {
  //     res.json(200, phone);
  //   });
  // })
  //
  // .delete('/api/phones', function (req, res) {
  //   // http://mongoosejs.com/docs/api.html#query_Query-remove
  //   Phone.remove({ completed: true }, function ( err ) {
  //     res.json(200, {msg: 'OK'});
  //   });
  // })
  //
  // .get('/api/phones/:id', function (req, res) {
  //   // http://mongoosejs.com/docs/api.html#model_Model.findById
  //   Phone.findById( req.params.id, function ( err, phone ) {
  //     res.json(200, phone);
  //   });
  // })
  //
  // .put('/api/phones/:id', function (req, res) {
  //   // http://mongoosejs.com/docs/api.html#model_Model.findById
  //   Phone.findById( req.params.id, function ( err, phone ) {
  //     phone.title = req.body.title;
  //     phone.completed = req.body.completed;
  //     // http://mongoosejs.com/docs/api.html#model_Model-save
  //     phone.save( function ( err, phone ){
  //       res.json(200, phone);
  //     });
  //   });
  // })
  //
  // .delete('/api/phones/:id', function (req, res) {
  //   // http://mongoosejs.com/docs/api.html#model_Model.findById
  //   Phone.findById( req.params.id, function ( err, phone ) {
  //     // http://mongoosejs.com/docs/api.html#model_Model.remove
  //     phone.remove( function ( err, phone ){
  //       res.json(200, {msg: 'OK'});
  //     });
  //   });
  // });
