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

var REPOSITORY = process.env.REPOSITORY
if (!REPOSITORY) {
  log.error('no REPOSITORY in env')
  process.exit(1)
}

var USER = process.env.USER
if (!USER) {
  log.error('no USER in env')
  process.exit(1)
}

var PASSWORD = process.env.PASSWORD
if (!PASSWORD) {
  log.error('no PASSWORD in env')
  process.exit(1)
}

var path = require('path')
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
    var basenames = new Set()
    todos.forEach(function (todo) {
      basenames.add(todo.basename)
      if (todo.date) due.push(todo)
      else ongoing.push(todo)
    })
    ongoing.sort(function (a, b) {
      return a.basename.localeCompare(b.basename)
    })
    var options = Array.from(basenames).map(function (basename) {
      return `<option>${escapeHTML(basename)}</option>`
    })
    response.end(`
<!doctype html>
<html lang=en-US>
  <head>
    <meta charset=UTF-8>
    <meta name=viewport content=width=device-width,initial-scale=1>
    <title>TODO</title>
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

input {
  display: block;
  width: 100%;
  margin: 0.5rem 0;
  padding: 0.25rem;
  box-sizing: border-box;
}

header, main {
  max-width: 40rem;
  margin: 1rem auto;
}

td {
  padding: 0.25rem;
}
    </style>
  </head>
  <body>
    <header role=banner>
      <h1>TODO</h1>
    </header>
    <main role=main>
      <h2>New</h2>
      <form method=post>
        <label for=basename>Client</label>
        <input name=basename type=text list=basenames required>
        <datalist id=basenames>${options}</datalist>
        <label for=text>Text</label>
        <input name=text type=text required>
        <label for=Date>Date</label>
        <input name=date type=date required>
        <input type=submit>
      </form>
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
var runSeries = require('run-series')
var spawn = require('child_process').spawn

function post (request, response) {
  var auth = basicAuth(request)
  if (!auth || auth.name !== USER || auth.pass !== PASSWORD) {
    response.statusCode = 401
    response.setHeader('WWW-Authenticate', 'Basic realm=TODO')
    return response.end()
  }
  var basename, text, date
  request.pipe(
    new Busboy({ headers: request.headers })
      .on('field', function (name, value) {
        if (name === 'basename') {
          basename = value.trim()
        } else if (name === 'text') {
          text = value.trim()
        } else if (name === 'date') {
          date = new Date(value).toISOString().split('T')[0]
        }
      })
      .on('finish', function () {
        request.log.info({ basename, text, date }, 'data')
        var line = text + ' ' + date
        var file = path.join(REPOSITORY, basename)
        runSeries([
          loggedTask('fetch', function (done) {
            spawnGit(['fetch', 'origin'], done)
          }),
          loggedTask('reset --hard', function (done) {
            spawnGit(['reset', '--hard', 'origin/master'], done)
          }),
          loggedTask('append', function (done) {
            fs.appendFile(file, '\n' + line, done)
          }),
          loggedTask('git add', function (done) {
            spawnGit(['add', basename], done)
          }),
          loggedTask('git commit', function (done) {
            spawnGit(['commit', '--allow-empty-message', '-m', ''], done)
          }),
          loggedTask('git push', function (done) {
            spawnGit(['push', 'origin', 'master'], done)
          })
        ], function (error) {
          if (error) {
            response.statusCode = 500
            return response.end(error.message)
          }
          response.statusCode = 303
          response.setHeader('Location', '/')
          response.end()
        })

        function spawnGit (args, callback) {
          spawn('git', args, { cwd: REPOSITORY })
            .once('close', function (code) {
              if (code === 0) return callback()
              var description = `git ${args.join(' ')}`
              callback(new Error(`${description} failed`))
            })
        }

        function loggedTask (message, task) {
          return function (done) {
            task(function (error) {
              request.log.info('start: ' + message)
              if (error) return done(error)
              request.log.info('end: ' + message)
              done()
            })
          }
        }
      })
  )
}

server.listen(process.env.PORT || 8080, function () {
  var port = this.address().port
  log.info({ port }, 'listening')
})
