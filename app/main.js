const electron = require('electron');
const {app, ipcMain} = require('electron');

const env = require('./env.js');
const clientConfig = require('./lib/config.js');
const appState = require('./lib/state.js');
const migrate = require('./lib/migrate.js');
const TrayCtrl = require('./ui/tray/controller.js');
const SelectiveCtrl = require('./ui/selective/controller.js');
const SyncCtrl = require('./lib/sync/controller.js');
const StartupCtrl = require('./ui/startup/controller.js');
const AuthCtrl = require('./lib/auth/controller.js');
const AutoUpdateCtrl = require('./lib/auto-update/controller.js');
const FeedbackCtrl = require('./ui/feedback/controller.js');
const setMenu = require('./lib/menu.js');

const logger = require('./lib/logger.js');
const loggerFactory = require('./lib/logger-factory.js');
const configManager = require('./lib/config-manager/controller.js')(clientConfig);

var tray, selective, sync, feedback, autoUpdate;

var standardLogger = new loggerFactory(clientConfig.getAll());
var startup = StartupCtrl(env, clientConfig);
var auth = AuthCtrl(env, clientConfig);
var selective = SelectiveCtrl(env, clientConfig);

logger.setLogger(standardLogger);

process.on('uncaughtException', function(exception) {
  logger.error('uncaught exception', {
    category: 'bootstrap',
    error: exception
  });
});

var shouldQuit = app.makeSingleInstance((cmd, cwd) => {});

if(shouldQuit === true) {
  startup.showBalloonDir();
  app.quit();
}

function startApp() {
  logger.info('startApp', {category: 'main'});

  auth.retrieveLoginSecret().then(() => {
    logger.info('login secret recieved', {category: 'main'});

    ipcMain.once('tray-online-state-changed', function(event, state) {
      if(clientConfig.hadConfig()) {
        tray.create();
        autoUpdate.checkForUpdate();
      }

      logger.info('initial online state', {
        category: 'bootstrap',
        state: state
      });

      appState.set('onLineState', state);
      startup.checkConfig().then((result) => {
        logger.info('startup checkconfig successfull', {
          category: 'bootstrap',
        });

        if(!tray.isRunning()) {
          tray.create();
        }

        sync = SyncCtrl(env, tray);

        const welcomeWizard = result[2] === undefined || !result[2].welcomeWizardPromise ? Promise.resolve() : result[2].welcomeWizardPromise;

        welcomeWizard.then(() => {
          sync.setMayStart(true);

          startSync(true);

          electron.powerMonitor.on('suspend', () => {
            logger.info('The system is going to sleep', {
              category: 'bootstrap',
            });

            //abort a possibly active sync if not already paused
            if(sync && sync.isPaused() === false) {
              sync.pause(true);
            } else if(sync) {
              //if sync is paused kill a possible active watcher
              sync.killWatcher();
            }
          });

          electron.powerMonitor.on('resume', () => {
            logger.info('The system is resuming', {
              category: 'bootstrap',
            });

            startSync(true);
          });
        });
      }).catch((error) => {
        logger.error('startup checkconfig', {
            category: 'bootstrap',
            error: error
        });

        switch(error.code) {
          case 'E_BLN_CONFIG_CREDENTIALS':
            unlinkAccount();
          break;
          default:
            app.quit();
        }
      });
    });

    tray = TrayCtrl(env, clientConfig);
    autoUpdate = AutoUpdateCtrl(env, clientConfig, tray);
    feedback = FeedbackCtrl(env, clientConfig, sync);
  });
}

function unlinkAccount() {
  (function() {
    if(!sync) return Promise.resolve();

    return sync.pause(true);
  }()).then(function() {
    return auth.logout();
  }).then(() => {
    logger.info('logout successfull', {
      category: 'bootstrap',
    });

    tray.emit('unlink-account-result', true);
    tray.toggleState('loggedout', true);
  }).catch((error) => {
    logger.error('logout not successfull', {
      category: 'bootstrap',
      error: error
    });

    tray.emit('unlink-account-result', false);
  });
}

app.on('ready', function () {
  appState.set('updateAvailable', false);

  logger.info('App ready', {
      category: 'bootstrap',
  });

  setMenu();

  migrate().then(result => {
    startApp();
  }).catch(err => {
    logger.error('error during migration, quitting app', {
      category: 'bootstrap',
      error: err
    });

    app.quit();
  })
});

/** Main App **/
ipcMain.on('quit', function() {
  app.quit();
});

/** Tray **/
ipcMain.on('tray-toggle', function() {
  tray.toggle();
});

ipcMain.on('tray-hide', function() {
  tray.hide();
});

ipcMain.on('tray-show', function() {
  tray.show();
});

ipcMain.on('tray-online-state-changed', function(event, state) {
  logger.info('online state changed', {
    category: 'bootstrap',
    state: state
  });

  appState.set('onLineState', state);
  if(state === false) {
    //abort a possibly active sync if not already paused
    if(sync && sync.isPaused() === false) sync.pause(true);
    tray.toggleState('offline', true);
  } else {
    if(sync && sync.isPaused() === false) startSync(true);
    tray.toggleState('offline', false);
  }
});


/** Auto update **/
ipcMain.on('install-update', function() {
  logger.info('install-update triggered', {
    category: 'bootstrap',
  });

  autoUpdate.quitAndInstall();
});

ipcMain.on('check-for-update', function() {
  logger.info('check-for-update triggered', {
      category: 'bootstrap',
  });

  autoUpdate.checkForUpdate();
});

/** Sync **/
ipcMain.on('sync-transfer-start', () => {
  tray.syncTransferStarted();
});

ipcMain.on('sync-transfer-end', () => {
  tray.syncTransferEnded();
});

ipcMain.on('sync-toggle-pause', () => {
  if(!sync) {
    return tray.syncPaused();
  }

  tray.toggleState('pause', !sync.isPaused());
  sync.togglePause();
});

ipcMain.on('selective-open', function(event) {
  selective.open();
});

ipcMain.on('selective-close', function(event) {
  selective.close();
});

ipcMain.on('selective-apply', function(event, difference) {
  logger.info('Applying selective sync changes', {category: 'main', difference});

  if(sync) sync.updateSelectiveSync(difference, err => {
    selective.close();
  });
})

ipcMain.on('unlink-account', (event) => {
  logger.info('logout requested', {category: 'bootstrap'});
  unlinkAccount();
});

ipcMain.on('link-account', (event, id) => {
  logger.info('login requested', {category: 'bootstrap'});

  startup.checkConfig().then(() => {
    logger.info('login successfull', {
      category: 'bootstrap',
      data: clientConfig.getMulti(['username', 'loggedin'])
    });

    clientConfig.updateTraySecret();

    tray.toggleState('loggedout', false);
    startSync(true);
    event.sender.send('link-account-result', true);
  }).catch((err) => {
    if(err.code !== 'E_BLN_OAUTH_WINDOW_OPEN') {
      logger.error('login not successfull', {
        category: 'bootstrap',
        error: err
      });
    } else {
      logger.info('login aborted as there is already a login window open', {
        category: 'bootstrap',
      });
    }

    event.sender.send('link-account-result', false);
  });
});

ipcMain.on('sync-error', (event, error, url, line, message) => {
  switch(error.code) {
    case 'E_BLN_API_REQUEST_UNAUTHORIZED':
      if(clientConfig.get('authMethod') === 'basic') {
        logger.info('got 401, end sync and unlink account', {category: 'bootstrap'});
        endSync();
        unlinkAccount();
      } else {
        logger.debug('got 401, refresh accessToken', {category: 'bootstrap'});
        auth.refreshAccessToken().then(() => {
          endSync();
          sync.resumeWatcher(false);
        }).catch(() => {
          logger.error('could not refresh accessToken, unlink instance', {category: 'bootstrap'});
          endSync();
          unlinkAccount();
        });
      }
    break;
    case 'E_BLN_CONFIG_CREDENTIALS':
      logger.error('credentials not set', {
        category: 'bootstrap',
        code: error.code
      });

      endSync();
      unlinkAccount();
    break;
    case 'E_BLN_CONFIG_BALLOONDIR':
    case 'E_BLN_CONFIG_CONFIGDIR':
    case 'E_BLN_CONFIG_CONFIGDIR_NOTEXISTS':
    case 'E_BLN_CONFIG_APIURL':
      //this should only happen, when user deletes the configuation, while the application is running
      logger.info('reinitializing config, config sync error occured', {
        category: 'bootstrap',
        code: error.code
      });

      clientConfig.initialize();
      endSync();
      startSync(true);
    break;
    case 'E_BLN_CONFIG_CONFIGDIR_ACCES':
      logger.error('config dir not accesible.', {
        category: 'bootstrap',
        error
      });
      endSync();
    break;
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
    case 'ECONNREFUSED':
    case 'EHOSTDOWN':
    case 'ESOCKETTIMEDOUT':
    case 'ECONNRESET':
      logger.error('sync terminated with networkproblems.', {
        category: 'bootstrap',
        code: error.code
      });
      endSync();
      tray.emit('network-offline');
    break;
    default:
      logger.error('Uncaught sync error. Resetting cursor and db', {
        category: 'bootstrap',
        error,
        url,
        line,
        errorMsg: message
      });

      configManager.resetCursorAndDb().then(function() {
        endSync();
        startSync(true);
      }).catch(function(err) {
        endSync();
        startSync(true);
      });
  }
});

/** Development Methods **/
if(env.name === 'development') {
  process.on('unhandledRejection', r => console.log(r));
}

if (process.platform === 'darwin' && app.dock && env.name === 'production') {
  //hide from dock on OSX in production
  app.dock.hide();
}

function startSync(forceFullSync) {
  if(!sync) {
    sync = SyncCtrl(env, tray);
  }

  if(appState.get('onLineState') === true) {
    sync.start(forceFullSync);
  } else {
    logger.info('Not starting Sync because client is offline', {
      category: 'bootstrap',
    });
  }
}

function endSync() {
  sync.endFullSync();
}
