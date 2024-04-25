import {
    Agent,
    AgentManager,
    AgentManagerOptions,
    AgentsAPI,
    Chat,
    ChatMode,
    ChatProgress,
    ChatProgressCallback,
    ConnectionState,
    CreateStreamOptions,
    Message,
    SupportedStreamScipt,
    VideoType,
} from './types/index';

import { Auth, StreamScript } from '.';
import { createAgentsApi } from './api/agents';
import { getRandom } from './auth/getAuthHeader';
import { SocketManager, createSocketManager } from './connectToSocket';
import { StreamingManager, createStreamingManager } from './createStreamingManager';
import { didApiUrl, didSocketApiUrl, mixpanelKey } from './environment';
import { Analytics, initializeAnalytics } from './services/mixpanel';

import { getAnaliticsInfo } from './utils/analytics';

interface AgentManagrItems {
    chat?: Chat;
    streamingManager?: StreamingManager<CreateStreamOptions>;
    socketManager?: SocketManager;
    messages: Message[];
    chatMode: ChatMode;
}

function getAgentStreamArgs(agent: Agent): CreateStreamOptions {
    if (!agent.presenter) {
        throw new Error('Presenter is not initialized');
    } else if (agent.presenter.type === VideoType.Clip) {
        return {
            videoType: VideoType.Clip,
            driver_id: agent.presenter.driver_id,
            presenter_id: agent.presenter.presenter_id,
            stream_warmup: true,
        };
    }
    return {
        videoType: VideoType.Talk,
        source_url: agent.presenter.source_url,
        stream_warmup: true,
    };
}

function initializeStreamAndChat(
    agent: Agent,
    options: AgentManagerOptions,
    agentsApi: AgentsAPI,
    analytics: Analytics,
    chat?: Chat
) {
    return new Promise<{ chat: Chat; streamingManager: StreamingManager<CreateStreamOptions> }>(
        async (resolve, reject) => {
            let newChat = chat;

            const streamingManager = await createStreamingManager(agent.id, getAgentStreamArgs(agent), {
                ...options,
                callbacks: {
                    ...options.callbacks,
                    onConnectionStateChange: async state => {
                        if (state === ConnectionState.Connected) {
                            try {
                                if (!newChat) {
                                    newChat = await agentsApi.newChat(agent.id);

                                    analytics.track('agent-chat', {
                                        event: 'created',
                                        chat_id: newChat.id,
                                        agent_id: agent.id,
                                    });
                                }

                                if (streamingManager) {
                                    resolve({ chat: newChat, streamingManager });
                                }
                            } catch (error: any) {
                                console.error(error);
                                reject('Cannot create new chat');
                            }
                        } else if (state === ConnectionState.Fail) {
                            reject(new Error('Cannot create connection'));
                        }

                        options.callbacks.onConnectionStateChange?.(state);
                    },
                    onVideoStateChange(state, data) {
                        analytics.track('agent-video', { event: state, rtc_stats: data ?? [] });
                        options.callbacks.onVideoStateChange?.(state, data);
                    },
                },
                analytics: analytics
            }).catch(reject);
        }
    );
}

export function getAgent(agentId: string, auth: Auth, baseURL?: string): Promise<Agent> {
    const url = baseURL || didApiUrl;
    const agentsApi = createAgentsApi(auth, url);

    return agentsApi.getById(agentId);
}

function getInitialMessages(agent: Agent): Message[] {
    let content: string = '';
    if (agent.greetings && agent.greetings.length > 0) {
        const randomIndex = Math.floor(Math.random() * agent.greetings.length);
        content = agent.greetings[randomIndex];
    } else {
        content = `Hi! I'm ${agent.preview_name}, welcome to agents. How can I help you?`;
    }

    return [
        {
            content,
            id: getRandom(),
            role: 'assistant',
            created_at: new Date().toISOString(),
        },
    ];
}

/**
 * Creates a new Agent Manager instance for interacting with an agent, chat, and related connections.
 *
 * @param {string} agent - The ID or instance of the agent to chat with.
 * @param {AgentManagerOptions} options - Configurations for the Agent Manager API.
 * * @returns {Promise<AgentManager>} - A promise that resolves to an instance of the AgentsAPI interface.
 *
 * @throws {Error} Throws an error if the agent is not initialized.
 *
 * @example
 * const agentManager = await createAgentManager('id-agent123', { auth: { type: 'key', clientKey: '123', externalId: '123' } });
 */
export async function createAgentManager(agent: string, options: AgentManagerOptions): Promise<AgentManager> {
    const items: AgentManagrItems = {
        messages: [],
        chatMode: options.mode || ChatMode.Functional,
    };

    let lastMessageAnswerIdx = -1;

    const wsURL = options.wsURL || didSocketApiUrl;
    const baseURL = options.baseURL || didApiUrl;
    const mxKey = options.mixpanelKey || mixpanelKey;

    const agentsApi = createAgentsApi(options.auth, baseURL);

    const agentInstance = await agentsApi.getById(agent);

    items.messages = getInitialMessages(agentInstance);
    options.callbacks.onNewMessage?.(items.messages);

    const analytics = initializeAnalytics({ token: mxKey, agent: agentInstance, ...options });
    analytics.track('agent-sdk', { event: 'loaded', ...getAnaliticsInfo(agentInstance) });

    const socketManagerCallbacks: { onMessage: ChatProgressCallback } = {
        onMessage: (progress, data): void => {
            if ('content' in data) {
                const { content } = data;
                const lastMessage = items.messages[items.messages.length - 1];

                if (lastMessage?.role === 'assistant') {
                    if (lastMessageAnswerIdx < items.messages.length) {
                        lastMessage.content =
                            progress === ChatProgress.Partial ? lastMessage.content + content : content;
                    }

                    if (progress === ChatProgress.Answer) {
                        lastMessageAnswerIdx = items.messages.length;
                    }
                }

                if (progress === ChatProgress.Complete) {
                    analytics.track('agent-message-received', { messages: items.messages.length });
                }

                options.callbacks.onNewMessage?.(items.messages);
            }
        },
    };

    async function connect() {
        const socketManager = await createSocketManager(options.auth, wsURL, socketManagerCallbacks);

        const { streamingManager, chat } = await initializeStreamAndChat(
            agentInstance,
            options,
            agentsApi,
            analytics,
            items.chat
        );

        lastMessageAnswerIdx = -1;
        items.messages = getInitialMessages(agentInstance);
        options.callbacks.onNewMessage?.(items.messages);

        if (chat?.id && chat.id !== items.chat?.id) {
            options.callbacks.onNewChat?.(chat?.id);
        }

        items.streamingManager = streamingManager;
        items.socketManager = socketManager;
        items.chat = chat;

        changeMode(ChatMode.Functional);

        analytics.track('agent-chat', { event: 'connect', chatId: chat.id, agentId: agentInstance.id });
    }
    async function disconnect() {
        items.socketManager?.disconnect();
        await items.streamingManager?.disconnect();

        delete items.streamingManager;
        delete items.socketManager;

        items.messages = getInitialMessages(agentInstance);
        options.callbacks.onNewMessage?.(items.messages);

        analytics.track('agent-chat', { event: 'disconnect', chatId: items.chat?.id, agentId: agentInstance.id });
    }
    async function changeMode(mode: ChatMode) {
        if (mode !== items.chatMode) {
            analytics.track('agent-mode-change', { mode });
            items.chatMode = mode;

            if (items.chatMode !== ChatMode.Functional) {
                await disconnect();
            }

            options.callbacks.onModeChange?.(mode);
        }
    }

    return {
        agent: agentInstance,
        starterMessages: agentInstance.knowledge?.starter_message || [],
        connect,
        disconnect,
        changeMode,
        async reconnect() {
            if (!items.chat) {
                return connect();
            }

            const socketManager = await createSocketManager(options.auth, wsURL, socketManagerCallbacks);

            const { streamingManager, chat } = await initializeStreamAndChat(
                agentInstance,
                options,
                agentsApi,
                analytics,
                items.chat
            );

            items.streamingManager = streamingManager;
            items.socketManager = socketManager;

            changeMode(ChatMode.Functional);

            analytics.track('agent-chat', { event: 'reconnect', chatId: chat.id, agentId: agentInstance.id });
        },
        async chat(userMessage: string, append_chat: boolean = false) {
            try {
                if(userMessage.length >= 800) {
                    throw new Error('Message cannot be more than 800 characters');
                }

                const messageSentTimestamp = Date.now();
                items.messages.push({
                    id: getRandom(),
                    role: 'user',
                    content: userMessage,
                    created_at: new Date(messageSentTimestamp).toISOString(),
                });

                options.callbacks.onNewMessage?.(items.messages);

                if (userMessage.length === 0) {
                    throw new Error('Message cannot be empty');
                }

                if (items.chatMode === ChatMode.Maintenance) {
                    throw new Error('Chat is in maintenance mode');
                } else if (items.chatMode !== ChatMode.TextOnly) {
                    if (!items.streamingManager) {
                        throw new Error('Streaming manager is not initialized');
                    }

                    if (!items.chat) {
                        throw new Error('Chat is not initialized');
                    }
                } else if (!items.chat) {
                    items.chat = await agentsApi.newChat(agentInstance.id);
                }

                const response = await agentsApi.chat(agentInstance.id, items.chat.id, {
                    sessionId: items.streamingManager?.sessionId,
                    streamId: items.streamingManager?.streamId,
                    messages: items.messages,
                    chatMode: items.chatMode,
                    append_chat,
                });

                analytics.track('agent-message-send', { event: 'success', messages: items.messages.length + 1 });
                items.messages.push({
                    id: getRandom(),
                    role: 'assistant',
                    content: response.result ?? '',
                    created_at: new Date().toISOString(),
                    matches: response.matches,
                });

                if (response.result) {
                    analytics.track('agent-message-received', {
                        latency: Date.now() - messageSentTimestamp,
                        messages: items.messages.length,
                    });
                }

                options.callbacks.onNewMessage?.(items.messages);

                return response;
            } catch (e) {
                analytics.track('agent-message-send', { event: 'error', messages: items.messages.length });
                throw e;
            }
        },
        rate(messageId: string, score: 1 | -1, rateId?: string) {
            const message = items.messages.find(message => message.id === messageId);

            if (!items.chat) {
                throw new Error('Chat is not initialized');
            } else if (!message) {
                throw new Error('Message not found');
            }

            const matches: [string, string][] = message.matches?.map(match => [match.document_id, match.id]) ?? [];

            analytics.track('agent-rate', {
                event: rateId ? 'update' : 'create',
                thumb: score === 1 ? 'up' : 'down',
                knowledge_id: agentInstance.knowledge?.id ?? '',
                matches,
                score,
            });

            if (rateId) {
                return agentsApi.updateRating(agentInstance.id, items.chat.id, rateId, {
                    knowledge_id: agentInstance.knowledge?.id ?? '',
                    message_id: messageId,
                    matches,
                    score,
                });
            }

            return agentsApi.createRating(agentInstance.id, items.chat.id, {
                knowledge_id: agentInstance.knowledge?.id ?? '',
                message_id: messageId,
                matches,
                score,
            });
        },
        deleteRate(id: string) {
            if (!items.chat) {
                throw new Error('Chat is not initialized');
            }
            analytics.track('agent-rate-delete', { type: 'text', chat_id: items.chat?.id, id });
            return agentsApi.deleteRating(agentInstance.id, items.chat.id, id);
        },
        speak(payload: SupportedStreamScipt) {
            if (!items.streamingManager) {
                throw new Error('Streaming manager is not initialized');
            }

            function getScript(): StreamScript {
                if (!agentInstance.presenter) {
                    throw new Error('Presenter is not initialized');
                } else if (payload.type === 'text') {
                    const voiceProvider = payload.provider ? payload.provider : agentInstance.presenter.voice;

                    return {
                        type: 'text',
                        provider: voiceProvider,
                        input: payload.input,
                        ssml: payload.ssml || false,
                    };
                } else if (payload.type === 'audio') {
                    return { type: 'audio', audio_url: payload.audio_url };
                }

                throw new Error('Invalid payload');
            }

            const script = getScript();
            analytics.track('agent-speak', script);

            return items.streamingManager.speak({ script });
        },
    };
}
