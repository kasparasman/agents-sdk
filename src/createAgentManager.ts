import {
    Agent,
    AgentManager,
    AgentManagerOptions,
    AgentsAPI,
    Chat,
    ChatProgress,
    ConnectionState,
    CreateStreamOptions,
    Message,
    SupportedStreamScipt,
    VideoType,
} from '$/types/index';
import { Auth, StreamScript } from '.';
import { createAgentsApi } from './api/agents';
import { KnowledegeApi, createKnowledgeApi } from './api/knowledge';
import { createRatingsApi } from './api/ratings';
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
}

function getStarterMessages(agent: Agent, knowledgeApi: KnowledegeApi) {
    if (!agent.knowledge?.id) {
        return [];
    }

    return knowledgeApi.getKnowledge(agent.knowledge.id).then(knowledge => knowledge?.starter_message || []);
}

function getAgentStreamArgs(agent: Agent): CreateStreamOptions {
    if (agent.presenter.type === VideoType.Clip) {
        return {
            videoType: VideoType.Clip,
            driver_id: agent.presenter.driver_id,
            presenter_id: agent.presenter.presenter_id,
        };
    }
    return {
        videoType: VideoType.Talk,
        source_url: agent.presenter.source_url,
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
            const streamingManager = await createStreamingManager(getAgentStreamArgs(agent), {
                ...options,
                callbacks: {
                    ...options.callbacks,
                    onConnectionStateChange: async state => {
                        if (state === ConnectionState.Connected) {
                            try {
                                if (!chat) {
                                    chat = await agentsApi.newChat(agent.id);
                                    analytics.track('agent-chat', {
                                        event: 'created',
                                        chatId: chat.id,
                                        agentId: agent.id,
                                    });
                                }

                                resolve({ chat, streamingManager });
                            } catch (error: any) {
                                console.error(error);

                                reject('Cannot create new chat');
                            }
                        } else if (state === ConnectionState.Fail) {
                            reject(new Error('Cannot create connection'));
                        }

                        options.callbacks.onConnectionStateChange?.(state);
                    },
                },
            });
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
            id: getRandom(),
            content,
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
    };

    const baseURL = options.baseURL || didApiUrl;
    const wsURL = options.wsURL || didSocketApiUrl;
    const mxKey = options.mixpanelKey || mixpanelKey;

    const agentsApi = createAgentsApi(options.auth, baseURL);
    const ratingsAPI = createRatingsApi(options.auth, baseURL);
    const knowledgeApi = createKnowledgeApi(options.auth, baseURL);

    const agentInstance = await agentsApi.getById(agent);
    const starterMessages = await getStarterMessages(agentInstance, knowledgeApi);

    items.messages = [...getInitialMessages(agentInstance)];
    options.callbacks.onNewMessage?.(items.messages);

    const analytics = initializeAnalytics({ mixPanelKey: mxKey, agent: agentInstance, ...options });
    analytics.track('agent-sdk', { event: 'loaded', ...getAnaliticsInfo(agentInstance) });

    return {
        agent: agentInstance,
        starterMessages,
        async connect() {
            const socketManager = await createSocketManager(options.auth, wsURL, (progress, data) => {
                if ('content' in data) {
                    const { content } = data;
                    const lastMessage = items.messages[items.messages.length - 1];

                    if (lastMessage?.role === 'assistant') {
                        lastMessage.content =
                            progress === ChatProgress.Partial ? lastMessage.content + content : content;
                    }

                    options.callbacks.onNewMessage?.(items.messages);
                }

                options.callbacks?.onChatEvents?.(progress, data);
            });

            const { streamingManager, chat } = await initializeStreamAndChat(
                agentInstance,
                options,
                agentsApi,
                analytics
            );

            analytics.track('agent-chat', { event: 'connect', chatId: chat.id, agentId: agentInstance.id });

            items.streamingManager = streamingManager;
            items.socketManager = socketManager;
            items.chat = chat;
            items.messages = getInitialMessages(agentInstance);

            options.callbacks.onNewMessage?.(items.messages);
        },
        async disconnect() {
            items.socketManager?.disconnect();
            await items.streamingManager?.disconnect();

            analytics.track('agent-chat', { event: 'disconnect', chatId: items.chat?.id, agentId: agentInstance.id });
        },
        async chat(userMessage: string, append_chat: boolean = false) {
            if (userMessage.length === 0) {
                throw new Error('Message cannot be empty');
            }

            if (!items.chat) {
                throw new Error('Chat is not initialized');
            }

            if (!items.streamingManager) {
                throw new Error('Streaming manager is not initialized');
            }

            analytics.track('agent-message-send', { event: 'success', messages: items.messages.length + 1 });
            items.messages.push({
                id: getRandom(),
                role: 'user',
                content: userMessage,
                created_at: new Date().toISOString(),
            });

            const response = await agentsApi.chat(agentInstance.id, items.chat.id, {
                sessionId: items.streamingManager.sessionId,
                streamId: items.streamingManager.streamId,
                messages: items.messages,
                append_chat,
            });

            items.messages.push({
                id: getRandom(),
                role: 'assistant',
                content: response.result ?? '',
                created_at: new Date().toISOString(),
                matches: response.matches,
            });

            options.callbacks.onNewMessage?.(items.messages);

            return response;
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
                return ratingsAPI.update(rateId, {
                    agent_id: agentInstance.id,
                    knowledge_id: agentInstance.knowledge?.id ?? '',
                    chat_id: items.chat.id,
                    message_id: messageId,
                    matches,
                    score,
                });
            }

            return ratingsAPI.create({
                agent_id: agentInstance.id,
                knowledge_id: agentInstance.knowledge?.id ?? '',
                chat_id: items.chat.id,
                message_id: messageId,
                matches,
                score,
            });
        },
        deleteRate(id: string) {
            analytics.track('agent-rate-delete', { type: 'text', chat_id: items.chat?.id, id });
            return ratingsAPI.delete(id);
        },
        speak(payload: SupportedStreamScipt) {
            if (!items.streamingManager) {
                throw new Error('Streaming manager is not initialized');
            }

            function getScript(): StreamScript {
                if (payload.type === 'text') {
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
