var _ = require('lodash');
var fs = require('fs');
var UglifyJS = require('uglify-js');
var CleanCSS = require('clean-css');

module.exports = function(bosco) {
  var createKey = require('./AssetHelper')(bosco).createKey;

  function compileJs(staticAssets, jsAssets, next) {
    var bundleKeys = _.uniq(_.pluck(jsAssets, 'bundleKey'));
    var err;
    _.forEach(bundleKeys, function(bundleKey) {
      var items = _.where(jsAssets, {bundleKey: bundleKey});

      if (items.length === 0) { return; }

      var compiled;
      var serviceName;
      var buildNumber;
      var tag;
      var minificationConfig;

      // On first item retrieve shared properties
      if (!serviceName) {
        var firstItem = items[0];
        serviceName = firstItem.serviceName;
        buildNumber = firstItem.buildNumber;
        tag = firstItem.tag;
        minificationConfig = firstItem.minificationConfig;
      }

      // If a bundle is already minified it can only have a single item
      if (minificationConfig.alreadyMinified && items.length === 1) {
        bosco.log('Adding already minified ' + bundleKey.blue + ' JS assets ...');
        var item = items[0];
        var sourceMapContent;
        var sourceMapPath = item.path + minificationConfig.sourceMapExtension;
        if (bosco.exists(sourceMapPath)) {
          sourceMapContent = fs.readFileSync(item.path + minificationConfig.sourceMapExtension).toString();
        }
        compiled = {
          code: item.content,
          map: sourceMapContent,
        };
      } else {
        if (minificationConfig.alreadyMinified) {
          bosco.warn('More than one asset in bundle, re-minifying already minified ' + _.size(items) + ' ' + bundleKey.blue + ' JS assets ...');
        } else {
          bosco.log('Compiling ' + _.size(items) + ' ' + bundleKey.blue + ' JS assets ...');
        }

        var uglifyConfig = bosco.config.get('js:uglify');

        var uglifyOptions = {
          output: uglifyConfig ? uglifyConfig.outputOptions : null,
          compressor: uglifyConfig ? uglifyConfig.compressorOptions : null,
          mangle: uglifyConfig ? uglifyConfig.mangle : null,
          outSourceMap: tag + '.js.map',
          sourceMapIncludeSources: true,
        };

        try {
          compiled = UglifyJS.minify(_.values(_.pluck(items, 'path')), uglifyOptions);
        } catch (ex) {
          var errorMsg = 'There was an error minifying files in ' + bundleKey.blue + ', error: ' + ex.message;
          err = new Error(errorMsg);
          compiled = {
            code: '',
          };
        }
      }

      if (compiled.map) {
        var mapKey = createKey(serviceName, buildNumber, tag, 'js', 'js', 'map');
        var mapItem = {};
        mapItem.assetKey = mapKey;
        mapItem.serviceName = serviceName;
        mapItem.buildNumber = buildNumber;
        mapItem.path = 'js-source-map';
        mapItem.relativePath = 'js-source-map';
        mapItem.extname = '.map';
        mapItem.tag = tag;
        mapItem.type = 'js';
        mapItem.mimeType = 'application/javascript';
        mapItem.content = compiled.map;
        staticAssets.push(mapItem);
      }

      if (compiled.code) {
        var minifiedKey = createKey(serviceName, buildNumber, tag, null, 'js', 'js');
        var minifiedItem = {};
        minifiedItem.assetKey = minifiedKey;
        minifiedItem.serviceName = serviceName;
        minifiedItem.buildNumber = buildNumber;
        minifiedItem.path = 'minified-js';
        minifiedItem.relativePath = 'minified-js';
        minifiedItem.extname = '.js';
        minifiedItem.tag = tag;
        minifiedItem.type = 'js';
        minifiedItem.mimeType = 'application/javascript';
        minifiedItem.content = compiled.code;
        staticAssets.push(minifiedItem);
      }
    });
    next(err, staticAssets);
  }

  function compileCss(staticAssets, cssAssets, next) {
    var bundleKeys = _.uniq(_.pluck(cssAssets, 'bundleKey'));

    _.forEach(bundleKeys, function(bundleKey) {
      var items = _.where(cssAssets, {bundleKey: bundleKey});
      var cssContent = '';
      var serviceName;
      var buildNumber;
      var tag;

      if (items.length === 0) { return; }

      if (!serviceName) {
        var firstItem = items[0];
        serviceName = firstItem.serviceName;
        buildNumber = firstItem.buildNumber;
        tag = firstItem.tag;
      }

      bosco.log('Compiling ' + _.size(items) + ' ' + bundleKey.blue + ' CSS assets ...');

      _.forEach(items, function(file) {
        cssContent += fs.readFileSync(file.path);
      });

      var cleanCssConfig = bosco.config.get('css:clean');
      if (cleanCssConfig && cleanCssConfig.enabled) {
        cssContent = new CleanCSS(cleanCssConfig.options).minify(cssContent).styles;
      }
      if (cssContent.length === 0) {
        next({message: 'No css for tag ' + tag});
        return;
      }

      var assetKey = createKey(serviceName, buildNumber, tag, null, 'css', 'css');

      var minifiedItem = {};
      minifiedItem.assetKey = assetKey;
      minifiedItem.serviceName = serviceName;
      minifiedItem.buildNumber = buildNumber;
      minifiedItem.path = 'minified-css';
      minifiedItem.relativePath = 'minified-css';
      minifiedItem.extname = '.css';
      minifiedItem.tag = tag;
      minifiedItem.type = 'css';
      minifiedItem.mimeType = 'text/css';
      minifiedItem.content = cssContent;
      staticAssets.push(minifiedItem);
    });

    next(null, staticAssets);
  }

  function minify(staticAssets, next) {
    var jsAssets = _.where(staticAssets, {type: 'js'});
    var cssAssets = _.where(staticAssets, {type: 'css'});
    var remainingAssets = _.filter(staticAssets, function(item) {
      return item.type !== 'js' && item.type !== 'css';
    });

    compileJs(remainingAssets, jsAssets, function(err, minifiedStaticAssets) {
      if (err) { return next(err); }
      compileCss(minifiedStaticAssets, cssAssets, next);
    });
  }

  return {
    minify: minify,
  };
};
