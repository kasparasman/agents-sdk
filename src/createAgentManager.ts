import {
    Agent,
    AgentManager,
    AgentManagerOptions,
    AgentsAPI,
    Chat,
    CreateStreamOptions,
    Message,
    RatingPayload,
    SupportedStreamScipt,
    VideoType,
} from '$/types/index';
import {
    Auth,
    ChatProgress,
    StreamEvents,
    StreamScript,
    StreamingManager,
    createKnowledgeApi,
    createStreamingManager,
} from '.';
import { createAgentsApi } from './api/agents';
import { createRatingsApi } from './api/ratings';
import { SocketManager } from './connectToSocket';
import { didApiUrl, didSocketApiUrl } from './environment';

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

function initializeStreamAndChat(agent: Agent, options: AgentManagerOptions, agentsApi: AgentsAPI, chat?: Chat) {
    return new Promise<{ chat: Chat; streamingManager: StreamingManager<ReturnType<typeof getAgentStreamArgs>> }>(
        async (resolve, reject) => {
            const streamingManager = await createStreamingManager(getAgentStreamArgs(agent), {
                ...options,
                callbacks: {
                    ...options.callbacks,
                    onConnectionStateChange: async state => {
                        if (state === 'connected') {
                            try {
                                if (!chat) {
                                    chat = await agentsApi.newChat(agent.id);
                                }
                                resolve({ chat, streamingManager });
                            } catch (error: any) {
                                console.error(error);
                                reject(new Error('Cannot create new chat'));
                            }
                        } else if (state === 'failed') {
                            reject(new Error('Cannot create connection'));
                        }

                        options.callbacks.onConnectionStateChange?.(state);
                    },
                    // TODO remove when webscoket will return partial
                    onMessage: (event, data) => {
                        /*if (event === StreamEvents.ChatPartial) {
                            // Mock ws event result to remove in future
                           
                            options.callbacks.onChatEvents?.(ChatProgress.Partial, {
                                content: data,
                                event: ChatProgress.Partial,
                            });
                        } else*/
                        if (event === StreamEvents.ChatAnswer) {
                            console.log('ChatAnswer', event, data);
                            options.callbacks.onChatEvents?.(ChatProgress.Answer, {
                                content: data,
                                event: ChatProgress.Answer,
                            });
                        }
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
export async function createAgentManager(agent: string | Agent, options: AgentManagerOptions): Promise<AgentManager> {
    const baseURL = options.baseURL || didApiUrl;
    const wsURL = options.wsURL || didSocketApiUrl;
    const abortController: AbortController = new AbortController();
    const agentsApi = createAgentsApi(options.auth, baseURL);
    const ratingsAPI = createRatingsApi(options.auth, baseURL);
    const knowledgeApi = createKnowledgeApi(options.auth, baseURL);

    const agentInstance = typeof agent === 'string' ? await agentsApi.getById(agent) : agent;
    options.callbacks?.onAgentReady?.(agentInstance);

    const socketManager = await SocketManager(options.auth, wsURL, options.callbacks.onChatEvents);
    let { chat, streamingManager } = await initializeStreamAndChat(agentInstance, options, agentsApi);

    return {
        agent: agentInstance,
        chatId: chat.id,
        async reconnectToChat() {
            const { streamingManager: newStreamingManager } = await initializeStreamAndChat(
                agentInstance,
                options,
                agentsApi,
                chat
            );

            streamingManager = newStreamingManager;
        },
        terminate() {
            abortController.abort();
            socketManager.terminate();

            return streamingManager.terminate();
        },
        chat(messages: Message[]) {
            return agentsApi.chat(
                agentInstance.id,
                chat.id,
                { sessionId: streamingManager.sessionId, streamId: streamingManager.streamId, messages },
                { signal: abortController.signal }
            );
        },
        rate(payload: RatingPayload, id?: string) {
            if (id) {
                return ratingsAPI.update(id, payload);
            }

            return ratingsAPI.create(payload);
        },
        deleteRate(id: string) {
            return ratingsAPI.delete(id);
        },
        speak(payload: SupportedStreamScipt) {
            function getScript(): StreamScript {
                if (payload.type === 'text') {
                    return {
                        type: 'text',
                        provider: payload.provider,
                        input: payload.input,
                        ssml: payload.ssml || false,
                    };
                } else if (payload.type === 'audio') {
                    return {
                        type: 'audio',
                        audio_url: payload.audio_url,
                    };
                }

                throw new Error('Invalid payload');
            }

            return streamingManager.speak({ script: getScript() });
        },
        async getStarterMessages() {
            if (!agentInstance.knowledge?.id) {
                return [];
            }

            return knowledgeApi
                .getKnowledge(agentInstance.knowledge.id)
                .then(knowledge => knowledge?.starter_message || []);
        },
    };
}
