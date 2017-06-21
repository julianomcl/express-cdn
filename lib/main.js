//     express-cdn
//     Copyright (c) 2012- Nick Baugh <niftylettuce@gmail.com> (http://niftylettuce.com)
//     MIT Licensed

// Node.js module for delivering optimized, minified, mangled, gzipped,
//  and CDN-hosted assets in Express using S3 and CloudFront.

// * Author: [@niftylettuce](https://twitter.com/#!/niftylettuce)
// * Source: <https://github.com/niftylettuce/express-cdn>

// # express-cdn

var fs = require('fs'),
  url = require('url'),
  path = require('path'),
  mime = require('mime'),
  knox = require('knox'),
  s3 = require('s3'),
  walk = require('walk'),
  zlib = require('zlib'),
  async = require('async'),
  request = require('request'),
  _ = require('underscore'),
  uglify = require('uglify-es'),
  spawn = require('child_process').spawn,
  optipngPath = require('optipng-bin'),
  jpegtranPath = require('jpegtran-bin'),
  cleanCSS = require('clean-css')

_.str = require('underscore.string');
_.mixin(_.str.exports());

var logType = 'error';

var logger = function(obj) {
  switch (obj.type) {
    case 'error':
      console.error('================================');
      console.error(obj.msg);
      console.error('path:', obj.path);
      console.error('file:', obj.file);
      console.error('src:', obj.src);
      console.error('S3:', obj.S3);
      console.error(obj.err);
      console.error('================================');

      if (obj.err && obj.err instanceof Error) {
        throw new Error('CDN: ' + obj.err.message);
      }
      else if(obj.err){
        throw new Error('CDN: ' + obj.err);
      }
      else{
        throw new Error('CDN: ' + obj.msg);
      }
      break;
    case 'info':
      if (logType.indexOf('info') >= 0) {
        console.info('================================');
        console.info(obj.msg);
        console.info('path:', obj.path);
        console.info('file:', obj.file);
        console.info('================================');
      }
      break;
    case 'warn':
      if (logType.indexOf('warn') >= 0) {
        console.warn('================================');
        console.warn(obj.msg);
        console.warn('path:', obj.path);
        console.warn('file:', obj.file);
        console.warn('warning:', obj.warn);
        console.warn('================================');
      }
      break;
    case 'log':
      if (logType.indexOf('log') >= 0) {
        console.log('================================');
        console.log(obj.msg);
        console.log('path:', obj.path);
        console.log('file:', obj.file);
        console.log('================================');
      }
      break;
    default:
      console.log(obj);
      break;
  }

};

// `escape` function from Lo-Dash v0.2.2 <http://lodash.com>
// and Copyright 2012 John-David Dalton <http://allyoucanleet.com/>
// MIT licensed <http://lodash.com/license>
var escape = function(string) {
  return (string + '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};

var renderAttributes = function(attributes) {
  var str = [];
  for (var name in attributes) {
    if (_.has(attributes, name)) {
      str.push(escape(name) + '="' + escape(attributes[name]) + '"');
    }
  }
  return str.sort().join(" ");
};

var createTag = function(src, asset, attributes, version) {
  // Cachebusting
  version = version || '';
  // Enable "raw" output
  if ('raw' in attributes && attributes.raw === true) {
    return src + asset + version;
  }
  // Check mime type
  switch (mime.lookup(asset.split('?')[0])) {
    case 'application/javascript':
    case 'text/javascript':
      attributes.type = attributes.type || 'text/javascript';
      attributes.src = src + asset + version;
      return '<script ' + renderAttributes(attributes) + '></script>';
    case 'text/css':
      attributes.rel = attributes.rel || 'stylesheet';
      attributes.href = src + asset + version;
      return '<link ' + renderAttributes(attributes) + ' />';
    case 'image/png':
    case 'image/jpg':
    case 'image/jpeg':
    case 'image/pjpeg':
    case 'image/gif':
    case 'image/svg+xml':
      attributes.src = src + asset + version;
      return '<img ' + renderAttributes(attributes) + ' />';
    case 'image/x-icon':
    case 'image/vnd.microsoft.icon':
      attributes.rel = attributes.rel || 'shortcut icon';
      attributes.href = src + asset + version;
      return '<link ' + renderAttributes(attributes) + ' />';
    default:
      logger({type: 'error', msg: 'unknown asset type', path: asset, src: src});
  }
};

var renderTag = function(options, assets, attributes) {
  // Set attributes
  attributes = attributes || {};
  // In production mode, check for SSL
  var src = '', position,
    timestamp = 0;
  if (options.production) {
    if (options.ssl === 'relative') {
      src = '//' + options.domain;
    } else if (options.ssl) {
      src = 'https://' + options.domain;
    } else {
      src = 'http://' + options.domain;
    }
    // Process array by breaking file names into parts
    //  and check that array mime types are all equivalent
    if (typeof assets === 'object') {
      var concat = [],
        type = '';
      for (var b = 0; b < assets.length; b += 1) {
        if (type === '')
          type = mime.lookup(assets[b]);else if (mime.lookup(assets[b]) !== type)
          logger({type: 'error', msg: 'Mime types in CDN array of assets must all be the same', path: assets, file: fileName});

        // Push just the file name to the concat array
        concat.push(path.basename(assets[b]));
        timestamp = Math.max(timestamp, fs.statSync(path.join(options.publicDir, assets[b])).mtime.getTime());
      }
      var name = encodeURIComponent(concat.join("+"));
      position = name.lastIndexOf('.');
      //name = _(name).splice(position, 0, '.' + timestamp);
      name = name + '?cache=' + timestamp;
      return createTag(src, "/" + name, attributes);
    } else {
      try {
        var stats = fs.statSync(path.join(options.publicDir, assets));
        timestamp = stats.mtime.getTime();
      }
      catch (err) {
        logger({type: 'error', msg: 'File not found', path: assets, file: fileName, err: err});
      }
      position = assets.lastIndexOf('.');
      //var name = _(assets).splice(position, 0, '.' + timestamp)
      var name = assets + '?cache=' + timestamp;
      return createTag(src, name, attributes);
    }
  } else {
    // Development mode just pump out assets normally
    var version = '?v=' + new Date().getTime();
    var buf = [];
    if (typeof assets === 'object') {
      for (var i = 0; i < assets.length; i += 1) {
        buf.push(createTag(src, assets[i], attributes, version));
        if ((i + 1) === assets.length) return buf.join("\n");
      }
    } else if (typeof assets === 'string') {
      return createTag(src, assets, attributes, version);
    } else {
      logger({type: 'error', msg: 'Asset was not a string or an array', path: assets, file: fileName});
    }
  }

};

var compile = function(fileName, assets, S3, options, method, type, timestamp, callback) {
  var finishUpload = function() {
    return callback && callback();
  };
  return function(err, results) {
    if (err){
      logger({type: 'error', msg: 'Failed to compress stylesheet', path: assets, S3: S3, err: err});
    }
    var expires = new Date(new Date().getTime() + (31556926 * 1000)).toUTCString();
    var headers = {
      'Set-Cookie': '',
      'response-content-type': type,
      'Content-Type': type,
      'response-cache-control': 'maxage=31556926',
      'Cache-Control': 'maxage=31556926',
      'response-expires': expires,
      'Expires': expires,
      'response-content-encoding': 'gzip',
      'Content-Encoding': 'gzip',
      'x-amz-acl': 'public-read'
    };
    switch (method) {
      case 'uglify':
        logger({type: 'log', msg: 'Starting to minify files', path: assets, file: fileName});
        if (results instanceof Array)
          results = results.join("\n");
        try {
          var final_code = uglify.minify(results, {
            warnings: true
          });
        }
        catch (err) {
          logger({type: 'error', msg: 'Failed to execute minify', path: assets, file: fileName, err: err});
          return finishUpload();
          break;
        }
        if (final_code && final_code.error) {
          logger({type: 'error', msg: 'Failed to execute minify', path: assets, file: fileName, err: final_code.error});
          return finishUpload();
          break;
        }
        if (final_code && final_code.warnings) {
          logger({type: 'warn', msg: 'Warning on minify', path: assets, file: fileName, warn: final_code.warnings});
        }

        zlib.gzip(final_code.code, function(err, buffer) {
          if (err){
            logger({type: 'error', msg: 'Failed to compress script', path: assets, file: fileName, S3: S3, err: err});
            return finishUpload();
          }
          S3.putBuffer(buffer, fileName, headers, function(err, response) {
            if (err){
              logger({type: 'error', msg: 'Unsuccessful upload of script to S3', path: assets, file: fileName, S3: S3, err: err});
              return finishUpload();
            }
            if (response.statusCode !== 200) {
              logger({type: 'error', msg: 'Unsuccessful upload of script to S3', path: assets, file: fileName, S3: S3, err: response});
              return finishUpload();
            }
            else {
              logger({type: 'info', msg: 'Successfully uploaded script to S3', path: assets, file: fileName, S3: S3});
              return finishUpload();
            }
          });
        });
        break;
      case 'minify':
        logger({type: 'log', msg: 'Starting to minify files', path: assets, file: fileName});
        if (!(results instanceof Array)) {
          results = [results];
          assets = [assets]
        }
        var final_code = [];
        // NOTE: Added back in clean CSS, looks like its a bit less bad at minifcation now

        for (var key in results) {
          var minify = new cleanCSS().minify(results[key]);
          var assetPath = assets[key];
          var assetBasePath = path.dirname(assetPath);
          var fileBasePath = path.dirname(path.join(options.publicDir, fileName));

          // Add query string cache to css images, to the css files that already have a query string
          minify = minify.replace(/(\.jpg|\.png|\.gif|\.jpeg|\.jpg2|\.svm|\.ico|\.iff|\.ibm)\?/gmi, `$1?cache=${new Date().getTime()}&`);

          // Add query string cache to css images
          minify = minify.replace(/(\.jpg|\.png|\.gif|\.jpeg|\.jpg2|\.svm|\.ico|\.iff|\.ibm)(?!\?)/gmi, `$1?cache=${new Date().getTime()}`);

          // Add query string cache to css fonts, to the fonts that already have a query string
          minify = minify.replace(/(\.woff|\.woff2|\.eot|\.ttf|\.svg)\?/gmi, `$1?cache=${new Date().getTime()}&`);

          // Add query string cache to css fonts
          minify = minify.replace(/(\.woff|\.woff2|\.eot|\.ttf|\.svg)(?!\?)/gmi, `$1?cache=${new Date().getTime()}`);

          // Process images
          minify = minify.replace(/(?:background\-image|background|content|border\-image|cursor)\:[^;\n]*\)/g, function(rootMatch) {

            //Multiples Images URL per background
            return rootMatch.replace(/url\((?!data:)['"]?([^\)'"]+)['"]?\)/g, function(match, url) {

              if (options.production) {
                var relativePath = url;
                if ('/' === relativePath[0]) {
                  relativePath = path.join(options.publicDir, relativePath.substr(1));
                } else {
                  relativePath = path.join(assetBasePath, relativePath);
                }
                var mimeType = mime.lookup(relativePath);
                var imageResource = compile(relativePath.substr(options.publicDir.length + 1), relativePath, S3, options, 'image', mimeType, Date.now(), null, null)();
                return 'url(' + path.relative(fileBasePath, relativePath) + ')';
              } else {
                return 'url(' + url + ')';
              }
            });
          });

          // Process fonts
          minify = minify.replace(/(?:src)\:[^;]*\)/g, function(rootMatch) {

            //Multiples Fonts URL per SRC
            return rootMatch.replace(/url\((?!data:)['"]?([^\)'"]+)['"]?\)/g, function(match, url) {

              if (options.production) {
                var relativePath = url;
                if ('/' === relativePath[0]) {
                  relativePath = path.join(options.publicDir, relativePath.substr(1));
                } else {
                  relativePath = path.join(assetBasePath, relativePath);
                }
                var mimeType = mime.lookup(relativePath);
                var fontResource = compile(relativePath.substr(options.publicDir.length + 1), relativePath, S3, options, 'font', mimeType, Date.now(), null, null)();
                return 'url(' + path.relative(fileBasePath, relativePath) + ')';
              } else {
                return 'url(' + url + ')';
              }
            });
          });

          final_code.push(minify);
        }

        zlib.gzip(final_code.join("\n"), function(err, buffer) {
          if (err){
            logger({type: 'error', msg: 'Failed to compress stylesheet', path: assets, S3: S3, err: err});
            return finishUpload();
          }

          S3.putBuffer(buffer, fileName, headers, function(err, response) {
            if (err){
              logger({type: 'error', msg: 'Unsuccessful upload of stylesheet to S3', path: assets, S3: S3, err: err});
              return finishUpload();
            };
            if (response.statusCode !== 200) {
              logger({type: 'error', msg: 'Unsuccessful upload of stylesheet to S3', path: assets, S3: S3, err: err});
              return finishUpload();
            }
            else {
              logger({type: 'info', msg: 'Successfully uploaded stylesheet to S3', path: assets, S3: S3});
              return finishUpload();
            }
          });
        });
        break;
      case 'optipng':
        logger({type: 'log', msg: 'Starting to optipng images', path: assets, file: fileName});
        var img = assets;
        var optipng = spawn(optipngPath, [img]);
        optipng.stdout.on('data', function(data) {
          logger({type: 'info', msg: 'Optipng: ' + data, path: assets, file: fileName});
        });
        optipng.stderr.on('data', function(data) {
          logger({type: 'error', msg: 'Failed on optipng', path: assets, file: fileName, err: data});
        });
        optipng.on('exit', function(code) {
          // OptiPNG returns 1 if an error occurs
          if (code !== 0){
            logger({type: 'error', msg: 'Optipng returned an error during processing "' + img + '": ' + code, path: assets, file: fileName});
            return finishUpload();
          }
          logger({type: 'info', msg: 'Optipng exited with code ' + code, path: assets, file: fileName});

          fs.readFile(img, function(err, data) {
            if (err) {
              logger({type: 'error', msg: 'Failed to read image to S3', path: assets, file: fileName, err: err});
              return finishUpload();
            }
            zlib.gzip(data, function(err, buffer) {
              if (err) {
                logger({type: 'error', msg: 'Failed to compress image to S3', path: assets, file: fileName, S3: S3, err: err});
                return finishUpload();
              }
              S3.putBuffer(buffer, fileName, headers, function(err, response) {
                if (err){
                  logger({type: 'error', msg: 'Unsuccessful upload of image to S3', path: assets, file: fileName, S3: S3, err: err});
                  return finishUpload();
                }
                if (response.statusCode !== 200) {
                  logger({type: 'error', msg: 'Unsuccessful upload of image to S3', path: assets, file: fileName, S3: S3, err: response});
                  return finishUpload();
                }
                else {
                  logger({type: 'info', msg: 'Successfully uploaded image "' + fileName + '" to S3', path: assets, file: fileName, S3: S3});
                  // Hack to preserve original timestamp for view helper
                  fs.utimesSync(img, new Date(timestamp), new Date(timestamp));
                  return finishUpload();
                }
              });
            });
          });
        });
        break;
      case 'jpegtran':
        logger({type: 'log', msg: 'Starting to jpegtran images', path: assets, file: fileName});
        var jpg = assets;
        var jpegtran = spawn(jpegtranPath, ['-copy', 'none', '-optimize', '-outfile', jpg, jpg]);
        jpegtran.stdout.on('data', function(data) {
          logger({type: 'info', msg: 'jpegtran: ' + data, path: assets, file: fileName});
        });
        jpegtran.stderr.on('data', function(data) {
          logger({type: 'error', msg: 'Failed on jpegtran', path: assets, file: fileName, err: data});
        });
        jpegtran.on('exit', function(code) {
          logger({type: 'info', msg: 'jpegtran exited with code ' + code, path: assets, file: fileName});

          fs.readFile(jpg, function(err, data) {
            if (err) {
              logger({type: 'error', msg: 'Failed to read image to S3', path: assets, file: fileName, err: err});
              return finishUpload();
            }
            zlib.gzip(data, function(err, buffer) {
              if (err) {
                logger({type: 'error', msg: 'Failed to compress image to S3', path: assets, file: fileName, S3: S3, err: err});
                return finishUpload();
              }

              S3.putBuffer(buffer, fileName, headers, function(err, response) {
                if (err) {
                  logger({type: 'error', msg: 'Failed to upload image to S3', path: assets, file: fileName, S3: S3, err: err});
                  return finishUpload();
                }

                if (response.statusCode !== 200) {
                  logger({type: 'error', msg: 'Unsuccessful upload of image to S3', path: assets, file: fileName, S3: S3, err: response});
                  return finishUpload();
                } else {
                  logger({type: 'info', msg: 'Successfully uploaded image to S3', path: assets, file: fileName, S3: S3});
                  // Hack to preserve original timestamp for view helper
                  fs.utimesSync(jpg, new Date(timestamp), new Date(timestamp));
                  return finishUpload();
                }
              });
            });
          });
        });
        break;
      case 'image':
        logger({type: 'log', msg: 'Starting to upload image', path: assets, file: fileName});
        var image = assets.split("?")[0].split("#")[0];
        fileName = fileName.split("?")[0].split("#")[0];
        fs.readFile(image, function(err, data) {
          if (err) {
            logger({type: 'error', msg: 'Failed to read image', path: assets, file: fileName, err: err});
            return finishUpload();
          }
          zlib.gzip(data, function(err, buffer) {
            S3.putBuffer(buffer, fileName, headers, function(err, response) {
              if (err) {
                logger({type: 'error', msg: 'Failed to read image to S3', path: assets, file: fileName, S3: S3, err: err});
                return finishUpload();
              }
              if (response.statusCode !== 200) {
                logger({type: 'error', msg: 'Unsuccessful upload of image to S3', path: assets, file: fileName, S3: S3, err: response});
                return finishUpload();
              } else {
                logger({type: 'info', msg: 'Successfully uploaded imagee to S3', path: assets, file: fileName, S3: S3});
                // Hack to preserve original timestamp for view helper
                fs.utimesSync(image, new Date(timestamp), new Date(timestamp));
                return finishUpload();
              }
            });
          });
        });
        break;
      case 'font':
        logger({type: 'log', msg: 'Starting to upload font', path: assets, file: fileName});
        var image = assets.split("?")[0].split("#")[0];
        fileName = fileName.split("?")[0].split("#")[0];
        fs.readFile(image, function(err, data) {
          if (err) {
            logger({type: 'error', msg: 'Failed to read image to S3', path: assets, file: fileName, err: err});
            return finishUpload();
          }
          zlib.gzip(data, function(err, buffer) {
            if (err) {
              logger({type: 'error', msg: 'Failed to compress image', path: assets, file: fileName, S3: S3, err: err});
              return finishUpload();
            }
            S3.putBuffer(buffer, fileName, headers, function(err, response) {
              if (err) {
                logger({type: 'error', msg: 'Unsuccessful upload of image to S3', path: assets, file: fileName, S3: S3, err: err});
                return finishUpload();
              }
              if (response.statusCode !== 200) {
                logger({type: 'error', msg: 'Unsuccessful upload of image to S3', path: assets, file: fileName, S3: S3, err: response});
                return finishUpload();
              }
              else {
                logger({type: 'info', msg: 'Successfully uploaded imagee to S3', path: assets, file: fileName, S3: S3});
                // Hack to preserve original timestamp for view helper
                fs.utimesSync(image, new Date(timestamp), new Date(timestamp));
                return finishUpload();
              }
            });
          });
        });
        break;
    }
  };
};

var readUtf8 = function(file, callback) {
  fs.readFile(file, 'utf8', callback);
};

var js = ['application/javascript', 'text/javascript'];

// Check if the file already exists
var checkArrayIfModified = function(assets, fileName, S3, options, timestamp, type, callback) {
  var finishUpload = function() {
    return callback && callback(null, assets);
  };
  return function(err, response) {
    if (err) {
      logger({type: 'error', msg: 'Failed on function "checkArrayIfModified"', path: assets, file: fileName, S3: S3, err: err});
      return finishUpload();
    }
    if (response.statusCode === 200 && timestamp <= Date.parse(response.headers['last-modified'])) {
      logger({type: 'info', msg: 'Faile not modified and is already stored on S3', path: assets, file: fileName, S3: S3});
      return finishUpload();
    }
    else {
      logger({type: 'info', msg: 'The faile was not found on S3 or was modified recently', path: assets, file: fileName, S3: S3});
      // Check file type
      switch (type) {
        case 'application/javascript':
        case 'text/javascript':
          async.map(assets, readUtf8, compile(fileName, assets, S3, options, 'uglify', type, null, finishUpload));
          return;
        case 'text/css':
          async.map(assets, readUtf8, compile(fileName, assets, S3, options, 'minify', type, null, finishUpload));
          return;
        default:
          logger({type: 'error', msg: 'Unsupported mime type array "' + type + '"', path: assets, file: fileName});
      }
    }
  };
};

var checkStringIfModified = function(assets, fileName, S3, options, timestamp, callback) {
  var finishUpload = function() {
    return callback && callback(null, assets);
  };
  return function(err, response) {
    if (err) {
      logger({type: 'error', msg: 'Failed on function "checkStringIfModified"', path: assets, file: fileName, S3: S3, err: err});
      return finishUpload();
    }
    if (response.statusCode === 200 && timestamp <= Date.parse(response.headers['last-modified'])) {
      logger({type: 'info', msg: 'File not modified and is already stored on S3', path: assets, file: fileName, S3: S3});
      return finishUpload();
    }
    else {
      logger({type: 'info', msg: 'The file was not found on S3 or was modified recently', path: assets, file: fileName, S3: S3});
      // Check file type
      var type = mime.lookup(assets);
      switch (type) {
        case 'application/javascript':
        case 'text/javascript':
          readUtf8(assets, compile(fileName, assets, S3, options, 'uglify', type, null, finishUpload));
          return;
        case 'text/css':
          readUtf8(assets, compile(fileName, assets, S3, options, 'minify', type, null, finishUpload));
          return;
        case 'image/gif':
        case 'image/x-icon':
        case 'image/svg+xml':
          compile(fileName, assets, S3, options, 'image', type, timestamp, finishUpload)(null, null);
          return;
        case 'image/png':
          compile(fileName, assets, S3, options, 'optipng', type, timestamp, finishUpload)(null, null);
          return;
        case 'image/jpg':
        case 'image/jpeg':
        case 'image/pjpeg':
          compile(fileName, assets, S3, options, 'jpegtran', type, timestamp, finishUpload)(null, null);
          return;
        case 'image/x-icon':
        case 'image/vnd.microsoft.icon':
          compile(fileName, assets, S3, options, 'image', type, timestamp, finishUpload)(null, null);
          return;
        default:
          logger({type: 'error', msg: 'Unsupported mime type array "' + type + '"', path: assets, file: fileName});
          return;
      }
    }
  };
};

var processAssets = function(options, results, done) {
  // Create knox instance
  var S3 = knox.createClient({
    key: options.key,
    secret: options.secret,
    bucket: options.bucket,
    region: options.region || 'us-standard',
    endpoint: options.endpoint || null
  });

  // Go through each result and process it
  async.map(results, function(result, iter) {
    var assets = result;
    var type = '';
    var fileName = '';
    var position;
    var timestamp = 0;

    // Combine the assets if it is an array
    if (assets instanceof Array) {
      // Concat the file names together
      var concat = [];
      // Ensure all assets are of the same type
      for (var k = 0; k < assets.length; k += 1) {
        if (type === '')
          type = mime.lookup(assets[k]);else if (mime.lookup(assets[k]) !== type)
          logger({type: 'error', msg: 'Mime types in array do not match', path: assets, file: fileName});
        assets[k] = path.join(options.publicDir, assets[k]);
        timestamp = Math.max(timestamp, fs.statSync(assets[k]).mtime.getTime());

        concat.push(path.basename(assets[k]));
      }
      // Set the file name
      fileName = concat.join("+");
      position = fileName.lastIndexOf('.');
      //fileName = _(fileName).splice(position, 0, '.' + timestamp);
      S3.headFile(fileName, checkArrayIfModified(assets, fileName, S3, options, timestamp, type, iter));
    }
    else {
      // Set the file name
      fileName = assets.substr(1);
      assets = path.join(options.publicDir, assets);
      position = fileName.lastIndexOf('.');
      fs.exists(assets, function(exists) {
        if (exists) {
          timestamp = fs.statSync(assets).mtime.getTime();
        }
        S3.headFile(fileName, checkStringIfModified(assets, fileName, S3, options, timestamp, iter));
      });
    }
  }, function(err, results) {
    done(err, results);
  });
};

var CDN = function(app, options, callback) {

  // Validate express - Express app instance is an object in v2.x.x and function in 3.x.x
  if (!(typeof app === 'object' || typeof app === 'function')){
    logger({type: 'error', msg: 'Requires express'});
  }

  app.locals.CDNCSS = '';
  app.locals.CDNJS = '';

  app.locals.CDNCSSRESULT= function () {
    var cssTags =  app.locals.CDNCSS;
    app.locals.CDNCSS = '';
    return cssTags;
  };
  app.locals.CDNJSRESULT= function () {
    var jsTags =  app.locals.CDNJS;
    app.locals.CDNJS = '';
    return jsTags;
  };

  // Validate options
  var required = [
    'publicDir'
    , 'viewsDir'
    , 'domain'
    , 'bucket'
    , 'key'
    , 'secret'
    , 'ssl'
    , 'production'
  ];
  required.forEach(function(index) {
    if (typeof options[index] === 'undefined') {
      logger({type: 'error', msg: 'Missing option "' + index + '"', path: assets, file: fileName});
    }
  });

  logType = options.logType || 'error';

  if (options.logger) {
    if (typeof options.logger === 'function')
      logger = options.logger;
  }

  if (options.production && !options.disableWalk) {
    var walker = function() {
      var walker = walk.walk(options.viewsDir),
        results = [],
        regexCDN = /CDN\(((\([^)]+\)|[^)])+)\)/ig;
      walker.on('file', function(root, stat, next) {
        var validExts = options.extensions || ['.jade', '.ejs', '.pug'];
        var ext = path.extname(stat.name), text;

        if (_.indexOf(validExts, ext) !== -1) {
          fs.readFile(path.join(root, stat.name), 'utf8', function(err, data) {
            if (err){
              logger({type: 'error', msg: `Failed to read file: ${path.join(root, stat.name)}`, err: err});
            }
            var match;
            while ((match = regexCDN.exec(data))) {
              results.push(match[1]);
            }
            next();
          });
        } else {
          next();
        }
      });
      walker.on('end', function() {
        // Clean the array
        for (var i = 0; i < results.length; i += 1) {
          // Convert all apostrophes
          results[i] = results[i].replace(/\'/g, '"');
          // Insert assets property name
          results[i] = _(results[i]).splice(0, 0, '"assets": ');
          // Check for attributes
          var attributeIndex = results[i].indexOf('{');
          if (attributeIndex !== -1)
            results[i] = _(results[i]).splice(attributeIndex, 0, '"attributes": ');
          // Convert to an object
          results[i] = '{ ' + results[i] + ' }';
          try {
            results[i] = JSON.parse(results[i]);
          }
          catch (err) {
            logger({type: 'error', msg: 'Failed to parse results', path: results[i]});
          }
        }
        // Convert to an array of only assets
        var out = [];
        for (var k = 0; k < results.length; k += 1) {
          out[results[k].assets] = results[k].assets;
        }
        var clean = [];
        for (var c in out) {
          clean.push(out[c]);
        }
        // Process the results
        if (clean.length > 0) {
          processAssets(options, clean, function(err, results) {
            if (options.cache_file) {
              fs.writeFile(options.cache_file, JSON.stringify(results), function() {
                return callback && callback();
              });
            }
          });
        }
        else {
          logger({type: 'warn', msg: 'Empty results'});
          return;
        }
      });
    };

    if (options.cache_file) {
      fs.stat(options.cache_file, function(err, cache_stat) {
        if (err || !(cache_stat && cache_stat.isFile() && cache_stat.size > 0)) {
          walker();
        } else {
          // results are cached, everything already processed and on S3
        }
      });
    } else {
      walker();
    }
  }

  // Return the dynamic view helper
  return function(req, res) {
    return function(assets, attributes) {
      if (typeof assets === 'undefined'){
        logger({type: 'error', msg: 'Assets undefined'});
      }
      var tags = renderTag(options, assets, attributes);
      if (tags.indexOf('<link') == 0) {
        app.locals.CDNCSS = tags + app.locals.CDNCSS;
        logger({type: 'info', msg: 'Files Processed', path: app.locals.CDNCSS});
      }
      else if (tags.indexOf('<script') == 0){
        app.locals.CDNJS = tags + app.locals.CDNJS;
        logger({type: 'info', msg: 'Files Processed', path: app.locals.CDNJS});
      }
      else{
        return renderTag(options, assets, attributes);
      }
    };
  };

};

module.exports = CDN;
