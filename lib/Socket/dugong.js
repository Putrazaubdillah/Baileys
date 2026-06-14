import { proto as WAProto } from '../../WAProto/index.js';
import crypto from 'crypto';
import { generateWAMessageContent, generateWAMessageFromContent, generateWAMessage, generateMessageIDV2 } from '../Utils/index.js';

class kikyy {
    constructor(utils, waUploadToServer, relayMessageFn, userJid) {
        this.utils = utils;
        this.relayMessage = relayMessageFn;
        this.waUploadToServer = waUploadToServer;
        this.userJid = userJid;

        this.bail = {
            generateWAMessageContent: this.utils.generateWAMessageContent || generateWAMessageContent,
            generateMessageID: () => generateMessageIDV2(userJid),
            getContentType: (msg) => Object.keys(msg.message || {})[0]
        };
    }

    detectType(content) {
        if (content.requestPaymentMessage) return 'PAYMENT';
        if (content.productMessage) return 'PRODUCT';
        if (content.interactiveMessage) return 'INTERACTIVE';
        if (content.albumMessage) return 'ALBUM';
        if (content.eventMessage) return 'EVENT';
        if (content.pollResultMessage) return 'POLL_RESULT';
        if (content.groupStatusMessage) return 'GROUP_STORY';
        return null;
    }

    async handleGroupStory(content, jid, quoted) {
        const storyData = content.groupStatusMessage;
        let waMsgContent;

        if (storyData.message) {
            waMsgContent = storyData;
        } else {
            if (typeof this.bail?.generateWAMessageContent === 'function') {
                waMsgContent = await this.bail.generateWAMessageContent(storyData, {
                    upload: this.waUploadToServer
                });
            } else if (typeof this.utils?.generateWAMessageContent === 'function') {
                waMsgContent = await this.utils.generateWAMessageContent(storyData, {
                    upload: this.waUploadToServer
                });
            } else if (typeof this.utils?.prepareMessageContent === 'function') {
                waMsgContent = await this.utils.prepareMessageContent(storyData, {
                    upload: this.waUploadToServer
                });
            } else {
                waMsgContent = await generateWAMessageContent(storyData, {
                    upload: this.waUploadToServer
                });
            }
        }

        const msg = {
            message: {
                groupStatusMessageV2: {
                    message: waMsgContent.message || waMsgContent
                }
            }
        };

        return await this.relayMessage(jid, msg.message, {
            messageId: this.bail.generateMessageID()
        });
    }

    async handleAlbum(content, jid, quoted) {
        const array = content.albumMessage;
        const album = await generateWAMessageFromContent(jid, {
            messageContextInfo: {
                messageSecret: crypto.randomBytes(32),
            },
            albumMessage: {
                expectedImageCount: array.filter((a) => a.hasOwnProperty('image')).length,
                expectedVideoCount: array.filter((a) => a.hasOwnProperty('video')).length,
            },
        }, {
            userJid: this.userJid,
            quoted,
            upload: this.waUploadToServer
        });

        await this.relayMessage(jid, album.message, {
            messageId: album.key.id,
        });

        for (let item of array) {
            const img = await generateWAMessage(jid, item, {
                upload: this.waUploadToServer,
            });

            img.message.messageContextInfo = {
                messageSecret: crypto.randomBytes(32),
                messageAssociation: {
                    associationType: 1,
                    parentMessageKey: album.key,
                },
                participant: '0@s.whatsapp.net',
                remoteJid: 'status@broadcast',
                forwardingScore: 99999,
                isForwarded: true,
                mentionedJid: [jid],
                starred: true,
                labels: ['Y', 'Important'],
                isHighlighted: true,
                businessMessageForwardInfo: {
                    businessOwnerJid: jid,
                },
                dataSharingContext: {
                    showMmDisclosure: true,
                },
            };

            await this.relayMessage(jid, img.message, {
                messageId: img.key.id,
                quoted: {
                    key: {
                        remoteJid: album.key.remoteJid,
                        id: album.key.id,
                        fromMe: true,
                        participant: this.userJid,
                    },
                    message: album.message,
                },
            });
        }
        return album;
    }

    async handleEvent(content, jid, quoted) {
        const eventData = content.eventMessage;

        const msg = await generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2,
                        messageSecret: crypto.randomBytes(32),
                        supportPayload: JSON.stringify({
                            version: 2,
                            is_ai_message: true,
                            should_show_system_message: true,
                            ticket_id: crypto.randomBytes(16).toString('hex')
                        })
                    },
                    eventMessage: {
                        contextInfo: {
                            mentionedJid: [jid],
                            participant: jid,
                            remoteJid: 'status@broadcast',
                        },
                        isCanceled: eventData.isCanceled || false,
                        name: eventData.name,
                        description: eventData.description,
                        location: eventData.location || {
                            degreesLatitude: 0,
                            degreesLongitude: 0,
                            name: 'Location'
                        },
                        joinLink: eventData.joinLink || '',
                        startTime: typeof eventData.startTime === 'string' ? parseInt(eventData.startTime) : eventData.startTime || Date.now(),
                        endTime: typeof eventData.endTime === 'string' ? parseInt(eventData.endTime) : eventData.endTime || Date.now() + 3600000,
                        extraGuestsAllowed: eventData.extraGuestsAllowed !== false
                    }
                }
            }
        }, { quoted });

        await this.relayMessage(jid, msg.message, {
            messageId: msg.key.id
        });
        return msg;
    }

    async handlePollResult(content, jid, quoted) {
        const pollData = content.pollResultMessage;

        const msg = await generateWAMessageFromContent(jid, {
            pollResultSnapshotMessage: {
                name: pollData.name,
                pollVotes: pollData.pollVotes.map(vote => ({
                    optionName: vote.optionName,
                    optionVoteCount: typeof vote.optionVoteCount === 'number'
                        ? vote.optionVoteCount.toString()
                        : vote.optionVoteCount
                }))
            }
        }, {
            userJid: this.userJid,
            quoted
        });

        await this.relayMessage(jid, msg.message, {
            messageId: msg.key.id
        });

        return msg;
    }
}

export default kikyy;
