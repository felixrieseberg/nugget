var fs = require('fs')
var http = require('http')
var path = require('path')
var EventEmitter = require('events').EventEmitter
var got = require('got')
var isRedirect = require('is-redirect')
var log = require('single-line-log').stdout
var progress = require('progress-stream')
var prettyBytes = require('pretty-bytes')
var throttle = require('throttleit')
var debug = require('debug')('nugget')

function noop () {}

module.exports = function(urls, opts, cb) {
  if (!Array.isArray(urls)) urls = [urls]
  if (urls.length === 1) opts.singleTarget = true
  var downloads = []
  var errors = []
  var pending = 0
  var truncated = urls.length * 2 >= (process.stdout.rows - 15)
  
  var agent
  if (opts.sockets) {
    agent = new http.Agent({ maxSockets: +opts.sockets })
  }

  urls.forEach(function (url) {
    debug('start dl', url)
    pending++
    var dl = startDownload(url, opts, function done (err) {
      debug('done dl', url, pending)
      if (err) {
        debug('error dl', url, err)
        errors.push(err)
        dl.error = err.message
      }
      if (truncated) {
        var i = downloads.indexOf(dl)
        downloads.splice(i, 1)
        downloads.push(dl)
      }
      if (--pending === 0) {
        render()
        cb(errors.length ? errors : undefined)
      }
    })

    downloads.push(dl)

    dl.on('start', function (progressStream) {
      throttledRender()
    })

    dl.on('progress', function(data) {
      debug('progress', url, data.percentage)

      dl.speed = data.speed
      if (dl.percentage === 100) render()
      else throttledRender()
    })
  })

  var _log = opts.verbose ? log : noop
  render()
  var throttledRender = throttle(render, opts.frequency || 250)

  if (opts.singleTarget) return downloads[0]
  else return downloads

  function render () {
    var height = process.stdout.rows
    var rendered = 0
    var output = ""
    var totalSpeed = 0
    downloads.forEach(function (dl) {
      if (2 * rendered >= height - 15) return
      rendered++
      if (dl.error) {
        output += 'Downloading '+path.basename(dl.target)+'\n'
        output += 'Error: ' + dl.error + '\n'
        return
      }
      var pct = dl.percentage
      var speed = dl.speed
      var total = dl.fileSize
      totalSpeed += speed
      var bar = Array(Math.floor(50 * pct / 100)).join('=')+'>'
      while (bar.length < 50) bar += ' '
      output += 'Downloading '+path.basename(dl.target)+'\n'+
      '['+bar+'] '+pct.toFixed(1)+'%'
      if (total) output += ' of ' + prettyBytes(total)
      output += ' (' + prettyBytes(speed) + '/s)\n'
    })
    if (rendered < downloads.length) output += '\n... and ' + (downloads.length - rendered) + ' more\n'
    if (downloads.length > 1) output += '\nCombined Speed: ' + prettyBytes(totalSpeed) + '/s\n'
    _log(output)
  }

  function startDownload (url, opts, cb) {
    var targetName = path.basename(url)
    if (opts.singleTarget && opts.target) targetName = opts.target
    var target = path.resolve(opts.dir || process.cwd(), targetName)
    if (opts.resume) {
      resume(url, opts, cb)
    } else {
      download(url, opts, cb)
    }

    var progressEmitter = new EventEmitter()
    progressEmitter.target = target
    progressEmitter.speed = 0
    progressEmitter.percentage = 0

    return progressEmitter

    function resume (url, opts, cb) {
      fs.stat(target, function (err, stats) {
        if (err && err.code === 'ENOENT') {
          return download(url, opts, cb)
        }
        if (err) {
          return cb(err)
        }
        var offset = stats.size
        var req = got.get(url, {agent: agent})

        req.on('error', cb)
        req.on('response', function (resp) {
          resp.destroy()

          var length = parseInt(resp.headers['content-length'], 10)

          // file is already downloaded.
          if (length === offset) return cb()

          if (!isNaN(length) && length > offset && /bytes/.test(resp.headers['accept-ranges'])) {
            opts.range = [offset, length]
          }

          download(url, opts, cb)
        })
      })
    }

    function download(url, opts, cb) {
      var headers = opts.headers || {}
      if (opts.range) {
        headers.Range = 'bytes=' + opts.range[0] + '-' + opts.range[1]
      }
      var read = got.get(url, { headers: headers, agent: agent })
      var speed = "0 Kb"

      read.on('error', cb)
      read.on('response', function(resp) {
        debug('response', url, resp.statusCode)
        if (isRedirect(resp.statusCode)) return // hack for https://github.com/sindresorhus/got/issues/75
        if (resp.statusCode > 299 && !opts.force) return cb(new Error('GET ' + url + ' returned ' + resp.statusCode))
        var write = fs.createWriteStream(target, {flags: opts.resume ? 'a' : 'w'})
        write.on('error', cb)
        write.on('finish', cb)

        var fullLen
        var contentLen = Number(resp.headers['content-length'])
        var range = resp.headers['content-range']
        if (range) {
          fullLen = Number(range.split('/')[1])
        } else {
          fullLen = contentLen
        }

        progressEmitter.fileSize = fullLen
        if (range) {
          var downloaded = fullLen - contentLen
        }
        var progressStream = progress({ length: fullLen, transferred: downloaded }, onprogress)
        progressEmitter.emit('start', progressStream)

        resp
          .pipe(progressStream)
          .pipe(write)
      })

      function onprogress (p) {
        var pct = p.percentage
        progressEmitter.progress = p
        progressEmitter.percentage = pct
        progressEmitter.emit('progress', p)
      }
    }
  }
}
