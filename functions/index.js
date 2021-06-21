const functions = require('firebase-functions');
const admin = require('firebase-admin');
const crypto = require('crypto');
const Mailgun = require('mailgun-js');
const mailGunConfig = require('./mailgun.json');
const config = require('./config.json');
const inviteEmailTemplate = require('./invite_email_template.json');

/*
To add new functions for your project, please add your new functions as function groups.
For more details, please read https://firebase.google.com/docs/functions/organize-functions#group_functions
*/

admin.initializeApp();

const log = (uid, activity) => {
    const dt = new Date();
    const data ={
        'action': activity,
        'time': dt
    }
    return admin.firestore().collection('users').doc(uid).collection('activities').doc(String(dt.getTime())).set(data);
}

const getDoc = (docPath) => {
    const docRef = admin.firestore().doc(docPath);
    return docRef.get().then(docSnapshot => {
        if(docSnapshot.exists){
            return docSnapshot;
        }else{
            throw new Error('The document '+docPath+' does not exist');
        }
    });
}

// add account to firestore
const addAccount = (accountData) => {
    let acc = {
        'name':accountData.name,
        'owner': accountData.ownerId,
        'creationTime': new Date()
    }
    return admin.firestore().collection('accounts').add(acc).then(account => {
        return account;
    });
}

const getDocIndexById = (docArray, id) => {
    for(let i=0; i<docArray.length; i++){
        if(docArray[i].id === id){
            return i;
        }
    }
    return -1;
}

const sha256hash = (str) => {
    const hash = crypto.createHash('sha256');
    hash.update(str+":"+config.salt);
    return hash.digest('hex');
}

const sendInviteEmail = (email, senderName, inviteCode) => {
    let mailgun = new Mailgun({
        apiKey: mailGunConfig.api_key,
        domain: mailGunConfig.domain
    });
    let inviteUrl = mailGunConfig.invite_url+"/"+inviteCode;
    if(inviteEmailTemplate.format === 'html'){
        let data = {
            from: mailGunConfig.from,
            to: email,
            subject: inviteEmailTemplate.subject.replace(/{{sender_name}}/g, senderName).replace(/{{site_name}}/g, mailGunConfig.site_name),
            html: inviteEmailTemplate.body.replace(/{{sender_name}}/g, senderName).replace(/{{site_name}}/g, mailGunConfig.site_name).replace(/{{invite_link}}/g, inviteUrl)
        }
        return mailgun.messages().send(data);
    }else{
        let data = {
            from: mailGunConfig.from,
            to: email,
            subject: inviteEmailTemplate.subject.replace(/{{sender_name}}/g, senderName).replace(/{{site_name}}/g, mailGunConfig.site_name),
            text: inviteEmailTemplate.body.replace(/{{sender_name}}/g, senderName).replace(/{{site_name}}/g, mailGunConfig.site_name).replace(/{{invite_link}}/g, inviteUrl)
        }
        return mailgun.messages().send(data);
    }
}

// add a user to the account only when the user is not in the account
const addUserToAccount = (accountId, userId, isAdmin) => {
    return Promise.all([getDoc('accounts/'+accountId), getDoc('users/'+userId)]).then(([account, user]) => {
        if(typeof(account.data().access) === 'undefined' || account.data().access.indexOf(user.id) === -1){
            // add user to account if user doesn't exist
            let access = [];
            let admins = [];
            if(typeof(account.data().access) !== 'undefined'){
                access = account.data().access;
                admins = account.data().admins;
            }
            access.push(user.id);
            if(isAdmin){
                admins.push(user.id);
            }
            return account.ref.set({
                'admins': admins,
                'access': access,
                'adminCount': admins.length,
                'accessCount': access.length
            }, {merge: true});
        }else{
            throw new Error("invalid account ID or user ID");
        }
    }).then(res => {
        return {'result': 'success', 'accountId': accountId}
    });
}


exports.logUserDeletion = functions.auth.user().onDelete(user => {
    return log(user.uid, 'deleted account');
});

exports.logUserCreation = functions.auth.user().onCreate(user => {
    return log(user.uid, 'created account');
});

exports.userActivityCountIncremental = functions.firestore.document('/users/{userId}/activities/{activityId}').onCreate((snap, context) => {
    return admin.firestore().collection('users').doc(context.params.userId).set({'activityCount':admin.firestore.FieldValue.increment(1)},{merge: true});
});

exports.createAccount = functions.https.onCall((data, context) => {
    return addAccount({
        'name':data.accountName,
        'ownerId':context.auth.uid
    }).then(account => {
        log(context.auth.uid, 'created account id: '+account.id);
        return addUserToAccount(account.id, context.auth.uid, true);
    });
});


exports.getAccountUsers = functions.https.onCall((data, context) => {
    let account = null;
    return getDoc('/accounts/'+data.accountId).then(accountRef => {
        account = accountRef;
        if(accountRef.data().admins.indexOf(context.auth.uid) !== -1){
            let getUsers = [];
            accountRef.data().access.forEach(userId => {
                getUsers.push(getDoc('users/'+userId));
            });
            return Promise.all(getUsers);
        }else{
            throw new Error("Permission denied.");
        }
    }).then(users => {
        let records = [];
        users.forEach(user => {
            records.push({
                id: user.id,
                displayName: user.data().displayName,
                photoUrl: user.data().photoURL,
                lastLoginTime: user.data().lastLoginTime.toMillis(),
                role: (account.data().admins.indexOf(user.id)===-1?'user':'admin')
            });
        });
        records.sort((a,b) => a.displayName > b.displayName);
        return records;
    }).catch(err => {
        throw new functions.https.HttpsError('internal', err.message);
    });
});

exports.getAccountUser = functions.https.onCall((data, context) => {
    let account = null;
    return getDoc('/accounts/'+data.accountId).then(accountRef => {
        account = accountRef;
        if(accountRef.data().admins.indexOf(context.auth.uid) !== -1){
            if(accountRef.data().access.indexOf(data.userId) !== -1){
                return getDoc('/users/'+data.userId);
            }else{
                throw new Error("No user with ID: "+data.userId);
            }
        }else{
            throw new Error("Permission denied.");
        }
    }).then(user => {
        return {
            id: user.id,
            displayName: user.data().displayName,
            photoUrl: user.data().photoURL,
            lastLoginTime: user.data().lastLoginTime.toMillis(),
            role: (account.data().admins.indexOf(user.id)===-1?'user':'admin')
        }
    }).catch(err => {
        throw new functions.https.HttpsError('internal', err.message);
    });
});

exports.updateAccountUserRole = functions.https.onCall((data, context) => {
    return Promise.all([getDoc('accounts/'+data.accountId), getDoc('users/'+data.userId)]).then(([account, user]) => {
        if(account.data().admins.indexOf(context.auth.uid) !== -1){
            if(account.data().access.indexOf(data.userId) !== -1){
                switch(data.role){
                    case 'user':
                        if(account.data().admins.indexOf(data.userId) !== -1){
                            let admins = account.data().admins;
                            admins.splice(account.data().admins.indexOf(user.id),1);
                            return account.ref.set({
                                admins: admins,
                                adminCount: admins.length
                            },{merge:true});
                        }else{
                            return {}
                        }
                    case 'admin':
                        if(account.data().admins.indexOf(data.userId) === -1){
                            let admins = account.data().admins;
                            admins.push(user.id);
                            return account.ref.set({
                                admins: admins,
                                adminCount: admins.length
                            },{merge:true});
                        }else{
                            return {}
                        }
                    case 'remove': {
                        let access = account.data().access;
                        access.splice(account.data().access.indexOf(user.id),1);
                        let admins = account.data().admins;
                        if(account.data().admins.indexOf(data.userId) !== -1){
                            admins.splice(account.data().admins.indexOf(user.id),1);
                        }
                        return account.ref.set({
                            access: access,
                            accessCount: access.length,
                            admins: admins,
                            adminCount: admins.length
                        },{merge:true});
                    }
                    default:
                        throw new Error("Invalid role or action.");
                }
            }else{
                throw new Error("No user with ID: "+data.userId);
            }
        }else{
            throw new Error("Permission denied.");
        }
    }).then(writeResult => {
        return {
            result: 'success',
            role: data.role
        }
    }).catch(err => {
        throw new functions.https.HttpsError('internal', err.message);
    });
});

exports.addUserToAccount = functions.https.onCall((data, context) => {
    let account = null;
    return getDoc('/accounts/'+data.accountId).then(accountRef => {
        account = accountRef;
        if(accountRef.data().admins.indexOf(context.auth.uid) !== -1){
            return admin.auth().getUserByEmail(data.email);
        }else{
            throw new Error("Permission denied.");
        }
    }).then(userRecord => {
        if(account.data().access.indexOf(userRecord.uid) === -1){
            // user is found in the system and has no access to the account
            return addUserToAccount(data.accountId, userRecord.uid, data.role==='admin');            
        }else{
            throw new Error("The user already have access to the account.");
        }
    }).then(res => {
        return res;
    }).catch(err => {
        throw new functions.https.HttpsError('internal', err.message, err);
    });
});

exports.inviteEmailToAccount = functions.https.onCall((data, context) => {
    return getDoc('/accounts/'+data.accountId).then(account => {
        if(account.data().admins.indexOf(context.auth.uid) !== -1){
            // write invite record
            const hashedEmail = sha256hash(data.email.trim().toLowerCase())
            return admin.firestore().collection('invites').add({
                hashedEmail: hashedEmail,
                owner: context.auth.uid,
                account: data.accountId,
                role: data.role,
                time: new Date()
            });
        }else{
            throw new Error("Permission denied.");
        }
    }).then(invite => {
        // send email with invite id
        return sendInviteEmail(data.email, context.auth.token.name, invite.id);
    }).then(res => {
        return {
            result: 'success'
        }
    }).catch(err => {
        throw new functions.https.HttpsError('internal', err.message, err);
    });
});

exports.getInvite = functions.https.onCall((data, context) => {
    return getDoc('/invites/'+data.inviteId).then(invite => {
        if(invite.data().hashedEmail === sha256hash(context.auth.token.email.trim().toLowerCase())){
            return getDoc('/accounts/'+invite.data().account);
        }else{
            // the email doesn't match the invite's email address
            throw new Error("Invalid invite details.");
        }
    }).then(account => {
        return {
            accountId: account.id,
            accountName: account.data().name
        }
    }).catch(err => {
        throw new functions.https.HttpsError('internal', err.message);
    });
});


exports.acceptInvite = functions.https.onCall((data, context) => {
    return getDoc('/invites/'+data.inviteId).then(invite => {
        if(invite.data().hashedEmail === sha256hash(context.auth.token.email.trim().toLowerCase())){
            let time = new Date();
            if(invite.data().time.toMillis() > time.setHours(time.getHours()-config.invite_expire)){
                return addUserToAccount(invite.data().account, context.auth.uid, invite.data().role==='admin');
            }else{
                throw new Error("The invite has expired.");
            }
        }else{
            // the email doesn't match the invite's email address
            throw new Error("Invalid invite details.");
        }
    }).then(res => {
        return admin.firestore().doc('/invites/'+data.inviteId).delete();
    }).catch(err => {
        throw new functions.https.HttpsError('internal', err.message);
    });
});



