var log = require('pino')()

process.on('SIGINT', trap)
process.on('SIGQUIT', trap)
process.on('SIGTERM', trap)
process.on('uncaughtException', function (exception) {
  log.error(exception, 'uncaughtException')
  close()
})

function trap (signal) {
  log.info({ signal }, 'signal')
  close()
}

function close () {
  log.info('closing')
  server.close(function () {
    log.info('closed')
    process.exit(0)
  })
}

var PASSWORD = process.env.PASSWORD
if (!PASSWORD) {
  log.error('no PASSWORD in env')
  process.exit(1)
}

var path = require('path')
var REPOSITORY = process.env.REPOSITORY || 'todo'

var USER = process.env.USER
var PASSSWORD = process.env.PASSSWORD

if (!USER) {
  log.error('no USER in env')
  process.exit(1)
}

if (!PASSWORD) {
  log.error('no PASSWORD in env')
  process.exit(1)
}

var addLogs = require('pino-http')({ logger: log })
var parseURL = require('url-parse')
var server = require('http').createServer(function (request, response) {
  addLogs(request, response)
  var parsed = parseURL(request.url, true)
  request.query = parsed.query
  var method = request.method
  if (method === 'GET') return get(request, response)
  if (method === 'POST') return post(request, response)
  response.statusCode = 405
  response.end()
})

var basicAuth = require('basic-auth')
var escapeHTML = require('escape-html')
var fs = require('fs')
var runParallel = require('run-parallel')

function get (request, response) {
  var auth = basicAuth(request)
  if (!auth || auth.name !== USER || auth.pass !== PASSWORD) {
    response.statusCode = 401
    response.setHeader('WWW-Authenticate', 'Basic realm=TODO')
    return response.end()
  }
  fs.readdir(REPOSITORY, function (error, entries) {
    if (error) return internalError(error)
    var tasks = entries
      .filter(function (entry) {
        return entry !== 'sort' && !entry.startsWith('.')
      })
      .map(function (entry) {
        return function (done) {
          processFile(entry, done)
        }
      })
    runParallel(tasks, function (error, results) {
      if (error) return internalError(error)
      var todos = results
        .reduce(function (items, array) {
          return items.concat(array)
        })
        .sort(function (a, b) {
          if (a.date && b.date) {
            return a.date - b.date
          } else if (a.date) {
            return -1
          } else {
            return 1
          }
        })
      render(todos)
    })
  })

  function internalError (error) {
    request.log.error(error)
    response.statusCode = 500
    response.end()
  }

  function render (todos) {
    var due = []
    var ongoing = []
    todos.forEach(function (todo) {
      if (todo.date) due.push(todo)
      else ongoing.push(todo)
    })
    ongoing.sort(function (a, b) {
      return a.basename.localeCompare(b.basename)
    })
    response.end(`
<!doctype html>
<html lang=en-US>
  <head>
    <meta charset=UTF-8>
    <meta name=viewport content=width=device-width,initial-scale=1>
    <title>TODO</title>
    <link href=https://readable.kemitchell.com/all.css rel=stylesheet>
    <style>
table {
  border-collapse: collapse;
}

.overdue {
  background-color: rgba(200, 0, 0, 0.25);
}

.today {
  color: green;
}
    </style>
  </head>
  <body>
    <header role=banner>
      <h1>TODO</h1>
    </header>
    <main role=main>
      <h2>Due</h2>
      ${renderTable(due)}
      <h2>Ongoing</h2>
      ${renderTable(ongoing)}
    </main>
  </body>
</html>
    `.trim())
  }
}

var dateFormat = {
  year: 'numeric',
  month: 'long',
  day: 'numeric'
}

var tinyRelativeDate = require('tiny-relative-date')

function renderTable (todos) {
  var today = new Date()
  today.setSeconds(0)
  today.setMinutes(0)
  today.setMilliseconds(0)
  today = today.getTime()
  return `
  <table>
    <tbody>
      ${todos.map(row).join('')}
    </tbody>
  </table>
  `.trim()

  function row (todo) {
    var status = ''
    if (todo.date) {
      var time = todo.date.getTime()
      if (time < today) status = 'overdue'
      else if (time === today) status = 'today'
    }
    var cleanLine = todo.line
      .replace(dateRE, '')
      .replace(continuingRE, '')
    return `
<tr class=${status}>
  <td>${escapeHTML(todo.basename)}</td>
  <td>${escapeHTML(cleanLine)}</td>
  <td>${todo.date ? tinyRelativeDate(todo.date) : ''}</td>
</tr>
    `.trim()
  }
}

var dateRE = /(\d\d\d\d-\d\d-\d\d)/
var continuingRE = /\.\.\./

function processFile (basename, callback) {
  var file = path.join(REPOSITORY, basename)
  fs.readFile(file, 'utf8', function (error, text) {
    if (error) return callback(error)
    var lines = text
      .split('\n')
      .filter(function (element) {
        return !!element
      })
    var results = []
    lines.forEach(function (line) {
      var dateMatch = dateRE.exec(line)
      if (dateMatch) {
        var date = new Date(dateMatch[1])
        results.push({ date, line, basename })
      }
      var continuingMatch = continuingRE.exec(line)
      if (continuingMatch) {
        results.push({ line, continuing: true, basename })
      }
    })
    callback(null, results)
  })
}

var Busboy = require('busboy')
var pump = require('pump')
var runSeries = require('run-series')

function post (request, response) {
  request.pipe(
    new Busboy({ headers: request.headers })
      .on('field', function (name, value) {
        if (whitelist.includes(name)) data[name] = value.trim()
      })
      .on('file', function (field, stream, name, encoding, mime) {
        mkdirp(attachments, function (error) {
          if (error) return request.log.error(error)
          var file = path.join(attachments, name)
          pump(
            stream,
            fs.createWriteStream(file),
            function (error) {
              if (error) return request.log.error(error)
              data.files.push(file)
            }
          )
        })
      })
      .on('finish', function () {
        runSeries([
          function makeDirectory (done) {
            mkdirp(directory, done)
          },
          function writeDataFile (done) {
            var files = data.files.map(function (entry) {
              return { name: entry.name, mime: entry.mime }
            })
            var object = { data, questionnaire, files }
            fs.writeFile(
              path.join(directory, `data.json`),
              JSON.stringify(object, null, 2),
              done
            )
          },
          function loadClientData (done) {
            readClientData(data.cc, function (error, client) {
              if (error) return done(error)
              data.client = client
              done()
            })
          },
          function sendEMail (done) {
            email(data, request.log, done)
          }
        ], function (error) {
          if (error) {
            request.log.error(error)
            response.statusCode = 500
            return response.end(`<p>Internal Error</p>`)
          }
          response.end('<p>Success! You should receive an e-mail shortly.</p>')
        })
      })
  )
}

server.listen(process.env.PORT || 8080, function () {
  var port = this.address().port
  log.info({ port }, 'litening')
})
