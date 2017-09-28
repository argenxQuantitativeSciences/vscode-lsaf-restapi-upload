const vscode = require('vscode');
const fs = require("fs");
const findConfig = require('find-config');
const path = require('path');
const tmp = require('tmp');
const CredentialStore = require('./credentialstore/credentialstore.js');

const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5);
const credStore = new CredentialStore.CredentialStore("vscode-webdav:", ".webdav", "webdav-secrets.json");

function activate(context) {
    const uploadCommand = vscode.commands.registerCommand('extension.webdavUpload', upload);
    const compareCommand = vscode.commands.registerCommand('extension.webdavCompare', compare);

    statusBar.command = 'extension.webdavUpload';
    statusBar.text = '$(cloud-upload) Upload to WebDAV';

    context.subscriptions.push(statusBar);
    context.subscriptions.push(uploadCommand);
    context.subscriptions.push(compareCommand);

    statusBar.show();
}

exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}

exports.deactivate = deactivate;

function upload() {
    doWebdavAction(function(webdav, workingFile, remoteFile) {
        return new Promise(function(resolve, reject) {
            const editor = vscode.window.activeTextEditor;

            webdav.writeFile(remoteFile, editor.document.getText() , function(err) {
                if (err != null) {
                    console.error(err);
                    vscode.window.showErrorMessage('Failed to upload file to remote host: ' + err.message);
                    reject(err);
                } else {
                    const fileName = remoteFile.slice(remoteFile.lastIndexOf('/') + 1);

                    statusBar.text    = "$(cloud-upload) Uploaded " + fileName + "...";
                    statusBar.command = null;
                    statusBar.color   = '#4cff4c';

                    setTimeout(function() {
                        statusBar.text    = '$(cloud-upload) Upload to WebDAV';
                        statusBar.command = 'extension.webdavUpload';
                        statusBar.color   = '#fff';
                    }, 2000)

                    resolve(undefined);
                }
            });
        });
    });
}

function compare() {
    doWebdavAction(function(webdav, workingFile, remoteFile) {
        return new Promise(function(resolve, reject) {
            // Write the remote file to a local temporary file
            const extension = workingFile.slice(workingFile.lastIndexOf('.'));
            var tmpFile = tmp.fileSync({ postfix: extension });
            webdav.readFile(remoteFile, "utf8", function(error, data) {

                if (error != null) {
                    console.log(error);
                    reject(error);
                }

                fs.writeFileSync(tmpFile.name, data, function(err) {
                    if(err) {
                        console.log(err);
                        reject(error);
                    }
                });

                // Compare!
                try {
                    const fileName = remoteFile.slice(remoteFile.lastIndexOf('/') + 1);

                    vscode.commands.executeCommand('vscode.diff',
                        vscode.Uri.file(tmpFile.name),
                        vscode.Uri.file(workingFile),
                        fileName + ' (WebDAV Compare)',
                        {
                            preview: false, // Open the diff in an additional tab instead of replacing the current one
                            selection: null // Don't select any text in the compare
                        }
                    );
                    resolve(undefined);
                } catch (error) {
                    console.log(error);
                    reject(error);
                }
            });
        });
    });
}

function doWebdavAction(webdavAction) {
    const workingFile = vscode.window.activeTextEditor.document.uri.fsPath;
    const workingDir = workingFile.slice(0, workingFile.lastIndexOf(path.sep));

    // Read configuration
    const config = getEndpointConfigForCurrentPath(workingDir);

    // Ignore SSL errors, needed for self signed certificates
    if (config.remoteEndpoint.ignoreSSLErrors) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }

    // Initialize WebDAV
    const remoteFile = workingFile.replace(/\\/g, '/').replace(vscode.workspace.rootPath.replace(/\\/g, '/') + config.localRootPath, ''); // On Windows replace \ with /

    getWebdavCredentials(config.remoteEndpoint.url).then(credentials => {

        if (!credentials) {
            vscode.window.showWarningMessage('WebDAV login cancelled...');
            return;
        }

        const webdav =   require("webdav-fs")(config.remoteEndpoint.url, credentials._username, credentials._password);
        webdavAction(webdav, workingFile, remoteFile).then(() => {
            // store the password only if there is no WebDAV error
            if (credentials.newCredentials) {
                storeCredentials(config.remoteEndpoint.url, credentials._username, credentials._password);
            }
        }, error => vscode.window.showErrorMessage('Error in WebDAV communication: ' + error));


    }, error => {
        console.error('Error while retrieving credentials', error);
        vscode.window.showErrorMessage('Error while retrieving credentials ');
    });
}

function getEndpointConfigForCurrentPath(absoluteWorkingDir) {
    const configFile = findConfig('webdav.json', {cwd: absoluteWorkingDir});

    if (configFile != null) {
        var allEndpointsConfig = JSON.parse(fs.readFileSync(configFile));

        var endpointConfigDirectory = configFile.slice(0, configFile.lastIndexOf(path.sep));

        const relativeWorkingDir = absoluteWorkingDir.slice(endpointConfigDirectory.length).replace(/\\/g, '/'); // On Windows replace \ with /

        let endpointConfig = null;
        let currentSearchPath = relativeWorkingDir;
        let configOnCurrentSearchPath = null;

        while (!endpointConfig) {

            if (currentSearchPath === "") {
                vscode.window.showErrorMessage('Cannot find a remote endpoint configuration for the current working directory ' + relativeWorkingDir + ' in webdav.json...');
                return null;
            }

            configOnCurrentSearchPath = allEndpointsConfig[currentSearchPath];

            if (configOnCurrentSearchPath) {
                endpointConfig = configOnCurrentSearchPath;
            } else {
                currentSearchPath = currentSearchPath.slice(0, currentSearchPath.lastIndexOf("/"));
            }
        }

        return {
            localRootPath: currentSearchPath,
            remoteEndpoint: endpointConfig
        }
    } else {
        vscode.window.showErrorMessage('Endpoint config file for WebDAV (webdav.json) not found...');
    }
}

function getWebdavCredentials(url) {
    return new Promise(function(resolve, reject) {
        credStore.GetCredential(url).then(credentials => {
            if (credentials !== undefined) {
                resolve(credentials);
            } else {
                askForCredentials(url).then(credentials =>{
                    resolve(credentials);
                }, error => reject(error));
            }
        }, error => reject(error))
    });
}

function askForCredentials(url) {
    return new Promise(function(resolve, reject) {
        vscode.window.showInputBox({prompt: 'Username for ' + url + ' ?'}).then(username => {
            if (!username) {
                resolve(undefined);
                return;
            }

            vscode.window.showInputBox({prompt: 'Password ?', password: true}).then(password => {
                if (!password) {
                    resolve(undefined);
                    return;
                }

                resolve({
                    newCredentials: true,
                    _username: username,
                    _password: password
                });
            }, error => reject(error));
        }, error => reject(error));
    });
}

function storeCredentials(url, username, password) {
    credStore.SetCredential(url, username, password)
}