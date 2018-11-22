var events = require('events');
var util = require('util');
var Chrome = require('chrome-remote-interface');
var common = require('./common.js');
var Page = require('./page.js');
var har = require('./har.js');

var NEUTRAL_URL = 'about:blank';
var CLEANUP_SCRIPT = 'chrome.benchmarking.closeConnections();';
var PAGE_DELAY = 1000;

function Client(urls, options) {
    var self = this;
    var pages = [];

    options = options || {};
    options.fetchContent = !!(options.fetchContent) || false;
    options.onLoadDelay = options.onLoadDelay || 0;
    options.onLastResponseDelay = options.onLastResponseDelay || 0;
    options.force = !!(options.force) || false;
    options.prepare = options.prepare || '';

    // начинаем работу
    Chrome(options, function (chrome) {
        function loadUrl(index) {
            if (index < urls.length) {
                var url = urls[index];
                var page = new Page(index, url, chrome, options.fetchContent);
                var loadEventTimeout;
                var onLastResponseTimeout;
                var giveUpTimeout;
                var isFinished = false;

                pages[index] = page;

                // обрабатываем следующую страницу
                var next = function () {
                    clearTimeout(loadEventTimeout);
                    clearTimeout(onLastResponseTimeout);
                    clearTimeout(giveUpTimeout);

                    common.dump('--- End: ' + url);
                    self.emit(page.isFailed() ? 'pageError' : 'pageEnd', url);
                    chrome.removeAllListeners('event');

                    // переходим к следующей странице
                    // после задержки
                    setTimeout(function () {
                        loadUrl(index + 1);
                    }, PAGE_DELAY);
                };

                // перед переходом к следующей странице
                // получаем дополнительные данные
                var preNext = function () {
                    chrome.Runtime.evaluate({
                        expression: '(function () { return JSON.stringify({\
                                timing: performance.timing,\
                                entries: performance.getEntries()\
                            }); })()'
                    }, function (error, response) {
                        if (!error) {
                            isFinished = true;
                            page.performance = JSON.parse(response.result.value);

                            if (options.prepare) {
                                chrome.Runtime.evaluate({
                                    expression: options.prepare,
                                    awaitPromise: true
                                }, function (error, response) {
                                    next();
                                });
                            }
                            else {
                                next();
                            };
                        };
                    });
                };

                // загружаем пустую страницу
                // потому что нет способа остановить загрузку
                chrome.Page.navigate({'url': NEUTRAL_URL}, function (error, response) {
                    if (error) {
                        self.emit('error', new Error('Cannot load URL'));
                        chrome.close();
                    }
                });

                // останавливаемся после безуспешных попыток
                if (options.giveUpTime) {
                    giveUpTimeout = setTimeout(function () {
                        clearTimeout(loadEventTimeout);
                        clearTimeout(onLastResponseTimeout);
                        common.dump('--- Giving up: ' + url);
                        page.markAsFailed();
                        next();
                    }, options.giveUpTime * 1000);
                }

                // ожидаем события перед открытием
                // пользовательской страницы
                var neutralFrameid;

                chrome.on('event', function (message) {
                    switch (message.method) {
                    case 'Page.frameNavigated':

                        // сохраняем идентификатор пустой страницы
                        var frame = message.params.frame;

                        if (frame.url === NEUTRAL_URL) {
                            neutralFrameid = frame.id;
                        }
                        break;
                    case 'Page.frameStoppedLoading':

                        // если пустая загрузилась
                        if (message.params.frameId === neutralFrameid) {
                            chrome.removeAllListeners('event');

                            // встраиваем скрипт и загружаем страницу
                            common.dump('--- Start: ' + url);
                            self.emit('pageStart', url);
                            chrome.Runtime.evaluate({'expression': CLEANUP_SCRIPT}, function (error, response) {

                                // ошибка с соединением
                                // или исполнением скрипта
                                if (!options.force && (error || (response && response.wasThrown))) {
                                    var errorDetails = JSON.stringify(response, null, 4);
                                    var errorMessage = 'Cannot inject JavaScript: ' + errorDetails;
                                    
                                    common.dump(errorMessage);
                                    self.emit('error', new Error(errorMessage));
                                    chrome.close();
                                } else {
                                    chrome.Page.navigate({'url': url}, function (error, response) {
                                        if (error) {
                                            self.emit('error', new Error('Cannot load URL'));
                                            chrome.close();
                                        }
                                    });
                                }
                            });

                            // обрабатываем события
                            chrome.on('event', function (message) {
                                if (!isFinished) {
                                    page.processMessage(message);
                                };

                                // если страница загрузилась
                                if (page.isFinished()) {

                                    // продолжаем слушать события
                                    // после события load
                                    if (typeof loadEventTimeout === 'undefined') {
                                        loadEventTimeout = setTimeout(preNext, options.onLoadDelay);
                                    };

                                    // продолжаем слушать события, пока они есть
                                    clearTimeout(onLastResponseTimeout);
                                    onLastResponseTimeout = setTimeout(preNext, options.onLastResponseDelay);
                                }
                            });
                        }
                        break;
                    }
                });
            } else {

                // завершаем работу
                chrome.close();
                self.emit('end', har.create(pages));
            }
        }

        self.emit('connect');

        // предварительная настройка
        chrome.Page.enable();
        chrome.Network.enable();

        if (options.cache) {
            chrome.Network.setCacheDisabled({'cacheDisabled': false});
        }
        else {
            chrome.Network.setCacheDisabled({'cacheDisabled': true});
        };

        if (typeof options.userAgent === 'string') {
            chrome.Network.setUserAgentOverride({'userAgent': options.userAgent});
        };

        // начинаем!
        chrome.once('ready', function () {
            loadUrl(0);
        });
    }).on('error', function (err) {
        common.dump("Emitting 'error' event: " + err.message);
        self.emit('error', err);
    });
}

util.inherits(Client, events.EventEmitter);

module.exports = Client;
