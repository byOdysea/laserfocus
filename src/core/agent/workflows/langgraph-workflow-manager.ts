// LangGraph workflow management for AthenaAgent

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { createHash } from "crypto";
import logger from "@utils/logger";
import { CanvasEngine } from "../canvas/canvas-engine";
import { ConfigurationManager } from "../infrastructure/config/configuration-manager";
import { ToolStatusCallback, ConversationUpdate } from "../types/tool-status";
import { SystemPromptBuilder } from "../prompts/system-prompt-builder";

export interface WorkflowManager {
    createWorkflow(
        llm: BaseChatModel,
        tools: DynamicStructuredTool[],
        statusCallback?: ToolStatusCallback
    ): any;
    processMessage(
        workflow: any,
        message: string,
        config: any,
        onUpdate?: (update: ConversationUpdate) => void
    ): Promise<string>;
    streamMessage(
        workflow: any,
        message: string,
        config: any,
        onChunk: (chunk: string) => void,
        onUpdate?: (update: ConversationUpdate) => void
    ): Promise<string>;
    getMetricsSnapshot(): any;
}

export class LangGraphWorkflowManager implements WorkflowManager {
    private threadId?: string;
    private cachedSystemPrompt?: string;
    private lastCanvasHash?: string;

    private readonly metrics = {
        cacheHits: 0,
        cacheMisses: 0,
        requestTimes: [] as number[],
        promptBuildTimes: [] as number[],
        canvasHashTimes: [] as number[],
        totalRequests: 0,
        lastReportTime: Date.now(),
        startTime: Date.now()
    };

    private readonly METRICS_REPORT_INTERVAL = 5 * 60 * 1000;
    private metricsTimer?: NodeJS.Timeout;

    constructor(
        private statusCallback?: ToolStatusCallback,
        private canvasEngine?: CanvasEngine,
        private systemPromptBuilder?: SystemPromptBuilder
    ) {
        this.startMetricsReporting();
    }

    createWorkflow(llm: BaseChatModel, tools: DynamicStructuredTool[]): any {
        const llmWithTools = llm.bindTools ? llm.bindTools(tools) : llm;
        const toolNode = new ToolNode(tools);

        const shouldContinue = (state: typeof MessagesAnnotation.State) => {
            const transitionStart = performance.now();
            const lastMessage = state.messages[state.messages.length - 1];

            if (lastMessage instanceof AIMessage && lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
                const toolNames = lastMessage.tool_calls.map(tc => tc.name).join(', ');
                const transitionTime = performance.now() - transitionStart;
                logger.debug(`[Athena] Using tools: ${toolNames} (transition: ${transitionTime.toFixed(1)}ms)`);
                return "tools";
            }

            const transitionTime = performance.now() - transitionStart;
            logger.debug(`[Athena] No tools needed (transition: ${transitionTime.toFixed(1)}ms)`);
            return END;
        };

        const callAgent = async (state: typeof MessagesAnnotation.State, config?: RunnableConfig) => {
            const systemPrompt = await this.buildSystemPromptCached(llm);
            const messages = [new SystemMessage(systemPrompt), ...state.messages];

            try {
                const response = await llmWithTools.invoke(messages, config);
                return { messages: [response] };
            } catch (error: any) {
                logger.error(`[Athena] LLM invocation failed:`, error);
                const errorMessage = new AIMessage({
                    content: `I encountered an error: ${error.message}. Please try again.`
                });
                return { messages: [errorMessage] };
            }
        };

        const enhancedToolNode = async (state: typeof MessagesAnnotation.State, runnableConfig?: RunnableConfig) => {
            const nodeStart = performance.now();
            const lastMessage = state.messages[state.messages.length - 1];
            if (lastMessage instanceof AIMessage && lastMessage.tool_calls) {
                const onUpdateFromConfig = runnableConfig?.configurable?.onUpdate as ((update: ConversationUpdate) => void) | undefined;

                lastMessage.tool_calls.forEach((toolCall) => {
                    const setupTime = performance.now() - nodeStart;
                    logger.debug(`[Athena] Preparing tool call: ${toolCall.name} (node setup: ${setupTime.toFixed(1)}ms)`);

                    if (onUpdateFromConfig) {
                        onUpdateFromConfig({
                            type: 'tool-call',
                            toolName: toolCall.name,
                            toolInput: toolCall.args,
                            timestamp: new Date().toISOString(),
                            message: `Executing tool: ${toolCall.name}`
                        });
                    }
                });
            }

            let result;

            try {
                const toolExecutionStart = performance.now();
                result = await toolNode.invoke(state);
                const toolExecutionTime = performance.now() - toolExecutionStart;
                logger.debug(`[Athena] Tool execution completed in ${toolExecutionTime.toFixed(1)}ms`);

                if (lastMessage instanceof AIMessage && lastMessage.tool_calls && this.statusCallback) {
                    lastMessage.tool_calls.forEach((toolCall) => {
                        this.statusCallback({
                            toolName: toolCall.name,
                            status: 'completed',
                            timestamp: new Date().toISOString(),
                            metadata: { completed: true, executionTime: toolExecutionTime }
                        });
                    });
                }
            } catch (error) {
                logger.error(`[Athena] Tool execution failed:`, error);

                if (lastMessage instanceof AIMessage && lastMessage.tool_calls && this.statusCallback) {
                    lastMessage.tool_calls.forEach((toolCall) => {
                        this.statusCallback({
                            toolName: toolCall.name,
                            status: 'error',
                            timestamp: new Date().toISOString(),
                            metadata: { error: error instanceof Error ? error.message : String(error) }
                        });
                    });
                }

                if (lastMessage instanceof AIMessage && lastMessage.tool_calls?.[0]) {
                    const errorMessage = new ToolMessage({
                        content: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
                        tool_call_id: lastMessage.tool_calls[0].id || 'unknown'
                    });
                    result = { messages: [errorMessage] };
                }
            }

            return result;
        };

        const workflow = new StateGraph(MessagesAnnotation)
            .addNode("agent", callAgent)
            .addNode("tools", enhancedToolNode)
            .addEdge(START, "agent")
            .addConditionalEdges("agent", shouldContinue, {
                tools: "tools",
                [END]: END
            })
            .addEdge("tools", "agent");

        const checkpointer = new MemorySaver();
        return workflow.compile({ checkpointer });
    }

    async processMessage(
        workflow: any,
        message: string,
        config: any,
        onUpdate?: (update: ConversationUpdate) => void
    ): Promise<string> {
        this.threadId = config?.configurable?.thread_id;

        const requestStart = performance.now();

        const invokeConfig = {
            ...config,
            configurable: {
                ...config?.configurable,
                thread_id: this.threadId,
                onUpdate
            }
        };

        const result = await workflow.invoke({ messages: [new HumanMessage(message)] }, invokeConfig);
        const lastMessage = result.messages[result.messages.length - 1];
        const response = lastMessage?.content || "Task completed.";

        const requestTime = performance.now() - requestStart;
        this.recordRequestMetrics(requestTime);

        logger.info(`[Athena] Response: "${response}" (${requestTime.toFixed(1)}ms)`);
        return response;
    }

    async streamMessage(
        workflow: any,
        message: string,
        config: any,
        onChunk: (chunk: string) => void,
        onUpdate?: (update: ConversationUpdate) => void
    ): Promise<string> {
        this.threadId = config?.configurable?.thread_id;

        const requestStart = performance.now();

        let streamedContent = '';
        let chunkCount = 0;

        const streamAndInvokeConfig = {
            ...config,
            configurable: {
                ...config?.configurable,
                thread_id: this.threadId,
                onUpdate
            },
            version: "v2" as const
        };

        try {
            const eventStream = workflow.streamEvents(
                { messages: [new HumanMessage(message)] },
                streamAndInvokeConfig
            );

            let lastEventTime = performance.now();
            for await (const event of eventStream) {
                const currentTime = performance.now();
                const timeSinceLastEvent = currentTime - lastEventTime;

                if (timeSinceLastEvent > 100) {
                    logger.debug(`[Athena] Event stream gap: ${timeSinceLastEvent.toFixed(1)}ms before ${event.event}`);
                }

                if (event.event === "on_chat_model_stream" && event.data?.chunk?.content) {
                    const content = event.data.chunk.content;
                    if (typeof content === 'string' && content.length > 0) {
                        streamedContent += content;
                        chunkCount++;
                        onChunk(content);
                    }
                }

                lastEventTime = currentTime;
            }

            if (streamedContent.length > 0) {
                const requestTime = performance.now() - requestStart;
                this.recordRequestMetrics(requestTime);
                logger.info(`[Athena] Streaming successful: ${streamedContent.length} chars, ${chunkCount} chunks (${requestTime.toFixed(1)}ms)`);
                return streamedContent;
            }
        } catch (error) {
            logger.debug(`[LangGraphWorkflowManager] Streaming failed, falling back to invoke`);
        }

        try {
            const result = await workflow.invoke({ messages: [new HumanMessage(message)] }, streamAndInvokeConfig);
            const response = this.extractResponseContent(result);

            if (response && streamedContent.length === 0) {
                onChunk(response);
                const requestTime = performance.now() - requestStart;
                this.recordRequestMetrics(requestTime);
                logger.info(`[Athena] Fallback response provided: ${response.length} characters (${requestTime.toFixed(1)}ms)`);
                return response;
            }

            const requestTime = performance.now() - requestStart;
            this.recordRequestMetrics(requestTime);
            return streamedContent || response || "Response completed.";
        } catch (error) {
            logger.error(`[Athena] Both streaming and invoke failed:`, error);
            throw error;
        }
    }

    private async buildSystemPromptCached(llm: BaseChatModel): Promise<string> {
        performance.mark('prompt-cache-start');
        const promptStart = performance.now();

        if (this.canvasEngine && this.systemPromptBuilder) {
            const canvas = await this.canvasEngine.getCanvas();

            const hashStart = performance.now();
            const canvasHash = createHash('md5').update(JSON.stringify(canvas)).digest('hex');
            const hashTime = performance.now() - hashStart;
            this.metrics.canvasHashTimes.push(hashTime);

            if (this.cachedSystemPrompt && this.lastCanvasHash === canvasHash) {
                performance.mark('prompt-cache-hit');
                this.metrics.cacheHits++;
                const promptTime = performance.now() - promptStart;
                this.metrics.promptBuildTimes.push(promptTime);

                logger.debug('[Athena] Reusing cached system prompt', {
                    cacheHit: true,
                    hashTime: `${hashTime.toFixed(2)}ms`,
                    promptTime: `${promptTime.toFixed(2)}ms`,
                    cacheHitRatio: `${(this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses) * 100).toFixed(1)}%`
                });
                return this.cachedSystemPrompt;
            }

            performance.mark('prompt-cache-miss');
            this.metrics.cacheMisses++;

            const providerConfig = ConfigurationManager.getInstance().get().provider;
            const buildStart = performance.now();
            const prompt = await this.systemPromptBuilder.buildPrompt(canvas, providerConfig, this.threadId);
            const buildTime = performance.now() - buildStart;

            this.cachedSystemPrompt = prompt;
            this.lastCanvasHash = canvasHash;

            const promptTime = performance.now() - promptStart;
            this.metrics.promptBuildTimes.push(promptTime);

            logger.debug('[Athena] Built and cached new system prompt', {
                cacheHit: false,
                promptLength: prompt.length,
                canvasHash: canvasHash.slice(0, 8),
                hashTime: `${hashTime.toFixed(2)}ms`,
                buildTime: `${buildTime.toFixed(2)}ms`,
                totalTime: `${promptTime.toFixed(2)}ms`,
                cacheHitRatio: `${(this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses) * 100).toFixed(1)}%`
            });
            return prompt;
        }
        return "You are Athena, an AI assistant with desktop management capabilities.";
    }

    private extractResponseContent(result: any): string {
        const lastMessage = result.messages[result.messages.length - 1];
        const response = lastMessage?.content || "Task completed.";
        logger.info(`[Athena] Response: "${response}"`);
        return response;
    }

    private recordRequestMetrics(requestTime: number): void {
        this.metrics.requestTimes.push(requestTime);
        this.metrics.totalRequests++;
    }

    private startMetricsReporting(): void {
        this.metricsTimer = setInterval(() => {
            const now = Date.now();
            const totalRequests = this.metrics.totalRequests;
            const cacheHits = this.metrics.cacheHits;
            const cacheMisses = this.metrics.cacheMisses;
            const totalPromptBuildTime = this.metrics.promptBuildTimes.reduce((a, b) => a + b, 0);
            const totalCanvasHashTime = this.metrics.canvasHashTimes.reduce((a, b) => a + b, 0);
            const totalRequestTime = this.metrics.requestTimes.reduce((a, b) => a + b, 0);

            const averageRequestTime = totalRequestTime / totalRequests;
            const averagePromptBuildTime = totalPromptBuildTime / totalRequests;
            const averageCanvasHashTime = totalCanvasHashTime / totalRequests;
            const cacheHitRatio = cacheHits / (cacheHits + cacheMisses);

            logger.info(`[Athena] Workflow metrics - Total Requests: ${totalRequests}, Cache Hits: ${cacheHits}, Cache Misses: ${cacheMisses}, Cache Hit Ratio: ${cacheHitRatio.toFixed(2)}, Average Request Time: ${averageRequestTime.toFixed(2)}ms, Average Prompt Build Time: ${averagePromptBuildTime.toFixed(2)}ms, Average Canvas Hash Time: ${averageCanvasHashTime.toFixed(2)}ms`);

            this.metrics.cacheHits = 0;
            this.metrics.cacheMisses = 0;
            this.metrics.requestTimes = [];
            this.metrics.promptBuildTimes = [];
            this.metrics.canvasHashTimes = [];
            this.metrics.totalRequests = 0;
            this.metrics.lastReportTime = now;
            this.metrics.startTime = now;
        }, this.METRICS_REPORT_INTERVAL);
    }

    public stopMetricsReporting(): void {
        if (this.metricsTimer) {
            clearInterval(this.metricsTimer);
            this.metricsTimer = undefined;
        }
    }

    public getMetricsSnapshot(): any {
        const totalRequests = this.metrics.totalRequests;
        const cacheHits = this.metrics.cacheHits;
        const cacheMisses = this.metrics.cacheMisses;

        return {
            totalRequests,
            cacheHits,
            cacheMisses,
            cacheHitRatio: totalRequests > 0 ? cacheHits / (cacheHits + cacheMisses) : 0,
            averageRequestTime: this.metrics.requestTimes.length > 0
                ? this.metrics.requestTimes.reduce((a, b) => a + b, 0) / this.metrics.requestTimes.length
                : 0,
            averagePromptBuildTime: this.metrics.promptBuildTimes.length > 0
                ? this.metrics.promptBuildTimes.reduce((a, b) => a + b, 0) / this.metrics.promptBuildTimes.length
                : 0,
            averageCanvasHashTime: this.metrics.canvasHashTimes.length > 0
                ? this.metrics.canvasHashTimes.reduce((a, b) => a + b, 0) / this.metrics.canvasHashTimes.length
                : 0,
            uptimeMs: Date.now() - this.metrics.startTime
        };
    }
}

