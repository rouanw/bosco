var fs = require('fs');
var path = require('path');
var _ = require('lodash');
var async = require('async');
var glob = require('glob');

module.exports = function(bosco) {
  var AssetHelper = require('./AssetHelper')(bosco);
  var minify = require('./Minify')(bosco).minify;
  var doBuildWithInterpreter = require('./ExternalBuild')(bosco).doBuildWithInterpreter;
  var html = require('./Html')(bosco);
  var createAssetHtmlFiles = html.createAssetHtmlFiles;
  var attachFormattedRepos = html.attachFormattedRepos;

  function loadService(repo, next) {
    var repoPath = bosco.getRepoPath(repo);
    var boscoRepoConfig = path.join(repoPath, 'bosco-service.json');
    var repoPackageFile = path.join(repoPath, 'package.json');
    var boscoRepo = {};
    var boscoConfig;

    boscoRepo.name = repo;
    boscoRepo.path = repoPath;
    boscoRepo.repoPath = repoPath;

    if (bosco.exists(boscoRepoConfig)) {
      boscoConfig = JSON.parse(fs.readFileSync(boscoRepoConfig)) || {};
      boscoRepo = _.merge(boscoRepo, boscoConfig);
      boscoRepo.serviceName = boscoRepo.service && boscoRepo.service.name ? boscoRepo.service.name : repo;
      if (boscoRepo.assets && boscoRepo.assets.basePath) {
        boscoRepo.basePath = boscoRepo.assets.basePath;
      }
    }

    if (bosco.exists(repoPackageFile)) {
      boscoRepo.info = JSON.parse(fs.readFileSync(repoPackageFile) || {});
    }

    next(null, boscoRepo);
  }

  function globAsset(assetGlob, basePath) {
    var resolvedBasePath = path.resolve(basePath);
    var assets = glob.sync(assetGlob, {cwd: resolvedBasePath, nodir: true});
    return assets;
  }

  function createAssetList(boscoRepo, buildNumber, minified, tagFilter, next) {
    var assetHelper = AssetHelper.getAssetHelper(boscoRepo, tagFilter);
    var fileTypesWhitelist = bosco.options.fileTypesWhitelist;
    var staticAssets = [];
    var assetKey;
    var assetBasePath;
    var minificationConfig = {};

    if (boscoRepo.assets) {
      assetBasePath = boscoRepo.assets.basePath || '.';
      minificationConfig = {
        alreadyMinified: !!boscoRepo.assets.alreadyMinified,
        sourceMapExtension: boscoRepo.assets.sourceMapExtension || '.map',
      };
      _.forEach(_.pick(boscoRepo.assets, fileTypesWhitelist), function(assets, type) {
        _.forOwn(assets, function(value, tag) {
          if (!value) return;
          _.forEach(value, function(potentialAsset) {
            var globbedAssets = globAsset(potentialAsset, path.join(boscoRepo.path, assetBasePath));
            if (globbedAssets.length === 0) {
              var warning = path.join(assetBasePath, potentialAsset) + ': No matching files found.';
              bosco.warn(warning);
              assetHelper.addError(staticAssets, tag, warning);
            }
            _.forEach(globbedAssets, function(asset) {
              assetKey = path.join(boscoRepo.serviceName, buildNumber, asset);
              assetHelper.addAsset(staticAssets, buildNumber, assetKey, asset, tag, type, assetBasePath, true, minificationConfig);
            });
          });
        });
      });
    }

    if (boscoRepo.files) {
      _.forOwn(boscoRepo.files, function(assetTypes, tag) {
        assetBasePath = assetTypes.basePath || '.';
        minificationConfig = {
          alreadyMinified: !!assetTypes.alreadyMinified,
          sourceMapExtension: assetTypes.sourceMapExtension || '.map',
        };
        _.forEach(_.pick(assetTypes, fileTypesWhitelist), function(value, type) {
          if (!value) return;
          _.forEach(value, function(potentialAsset) {
            var assets = globAsset(potentialAsset, path.join(boscoRepo.path, assetBasePath));
            if (assets.length === 0) {
              var warning = path.join(assetBasePath, potentialAsset) + ': No matching files found.';
              bosco.warn(warning);
              assetHelper.addError(staticAssets, tag, warning);
            }
            _.forEach(assets, function(asset) {
              assetKey = path.join(boscoRepo.serviceName, buildNumber, asset);
              assetHelper.addAsset(staticAssets, buildNumber, assetKey, asset, tag, type, assetBasePath, true, minificationConfig);
            });
          });
        });
      });
    }

    next(null, staticAssets);
  }

  function getStaticAssets(options, next) {
    var repoTag = options.repoTag;
    var ignoreFailure = options.ignoreFailure;
    var failedBuilds = [];

    async.map(options.repos, loadService, function(err, services) {
      if (err) return next(err);

      // Remove any service that doesnt have an assets child
      // or doesn't match repo tag
      var assetServices = _.filter(services, function(service) {
        return (!repoTag || _.contains(service.tags, repoTag)) &&
          (service.assets || service.files) && service.name.match(options.repoRegex);
      });

      async.mapLimit(assetServices, bosco.concurrency.cpu, function(service, cb) {
        doBuildWithInterpreter(service, options, function(err) {
          if (err) {
            if (!ignoreFailure) return cb(err);
            failedBuilds.push({name: service.name, err: err});
          }
          createAssetList(service, options.buildNumber, options.minify, options.tagFilter, function(err, assets) {
            if (err) {
              if (!ignoreFailure) return cb(err);
              failedBuilds.push({name: service.name, err: err});
            }
            cb(null, assets);
          });
        });
      }, function(err, assetList) {
        if (err && !ignoreFailure) return next(err);

        var buildCount = assetList.length;
        var failedBuildCount = failedBuilds.length;
        var succeededBuildCount = buildCount - failedBuilds.length;

        bosco.console.log();
        bosco.log(succeededBuildCount + ' out of ' + buildCount + ' succeeded.');
        if (failedBuildCount) {
          bosco.error(failedBuildCount + ' out of ' + buildCount + ' failed:');
          _.forEach(failedBuilds, function(data) {
            var message = data.err.message.replace(/^\s+|\s+$/g, '');
            bosco.error(data.name.red + ': ' + message);
          });
        }

        var staticAssets = _.compact(_.flatten(assetList));

        if (staticAssets.length === 0) {
          return next();
        }

        if (!options.minify) return createAssetHtmlFiles(staticAssets, next);

        // Now go and minify
        minify(staticAssets, function(err, minifiedAssets) {
          if (err && !ignoreFailure) return next(err);
          createAssetHtmlFiles(minifiedAssets, next);
        });
      });
    });
  }

  function getStaticRepos(options, next) {
    async.map(options.repos, loadService, function(err, repos) {
      if (err) return next(err);
      attachFormattedRepos(repos, next);
    });
  }

  return {
    getStaticAssets: getStaticAssets,
    getStaticRepos: getStaticRepos,
  };
};
