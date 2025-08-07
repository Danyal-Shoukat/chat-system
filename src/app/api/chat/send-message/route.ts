import { NextRequest, NextResponse } from "next/server";
import Pusher from "pusher";
import { OpenAI } from "openai";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface RequestBody {
  message: string;
  sessionId: string;
  userId?: string;
}

interface SuccessResponse {
  success: boolean;
  messageId: string;
  message: string;
}

interface ErrorResponse {
  error: string;
  details?: string;
  errorCode?: string;
}

interface PusherUserMessage {
  message: string;
  userId: string;
  timestamp: string;
  type: "user";
}

interface PusherAssistantChunk {
  messageId: string;
  content: string;
  chunk: string;
  timestamp: string;
  isComplete: boolean;
  type: "assistant";
}

interface PusherAssistantComplete {
  messageId: string;
  content: string;
  timestamp: string;
  isComplete: boolean;
  type: "assistant";
}

interface PusherError {
  error: string;
  timestamp: string;
  details?: string;
  errorCode?: string;
}

function validateEnvVars(): void {
  const required = [
    "PUSHER_APP_ID",
    "PUSHER_KEY",
    "PUSHER_SECRET",
    "PUSHER_CLUSTER",
  ];

  if (
    !(
      process.env.NODE_ENV === "development" &&
      process.env.MOCK_OPENAI === "true"
    )
  ) {
    required.push("OPENAI_API_KEY");
  }

  for (const envVar of required) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }
}

let pusher: Pusher;
let openai: OpenAI | null = null;

try {
  validateEnvVars();

  pusher = new Pusher({
    appId: process.env.PUSHER_APP_ID!,
    key: process.env.PUSHER_KEY!,
    secret: process.env.PUSHER_SECRET!,
    cluster: process.env.PUSHER_CLUSTER!,
    useTLS: true,
  });

  if (
    !(
      process.env.NODE_ENV === "development" &&
      process.env.MOCK_OPENAI === "true"
    )
  ) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
    });
    console.log("OpenAI initialized");
  } else {
    console.log("Running in mock mode - OpenAI disabled");
  }

  console.log("Services initialized successfully");
} catch (error) {
  console.error("Failed to initialize services:", error);
  throw error;
}

const conversations = new Map<string, ChatMessage[]>();

function validateRequestBody(body: any): RequestBody {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be an object");
  }

  const { message, sessionId, userId = "anonymous" } = body;

  if (!message || typeof message !== "string") {
    throw new Error("Message is required and must be a string");
  }

  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("SessionId is required and must be a string");
  }

  if (message.trim().length === 0) {
    throw new Error("Message cannot be empty");
  }

  if (message.length > 4000) {
    throw new Error("Message too long (max 4000 characters)");
  }

  return { message: message.trim(), sessionId, userId };
}

function handleOpenAIError(error: any): {
  message: string;
  code: string;
  status: number;
} {
  console.error("OpenAI Error Details:", {
    status: error?.status,
    code: error?.code,
    type: error?.type,
    message: error?.message,
  });

  if (error?.status === 429) {
    if (error?.code === "insufficient_quota") {
      return {
        message: "OpenAI API quota exceeded.",
        code: "QUOTA_EXCEEDED",
        status: 429,
      };
    }
    return {
      message: "OpenAI rate limit exceeded. Please try again in a moment.",
      code: "RATE_LIMITED",
      status: 429,
    };
  }

  if (error?.status === 401) {
    return {
      message:
        "OpenAI API key is invalid. Please check your API key configuration.",
      code: "AUTH_FAILED",
      status: 500,
    };
  }

  if (error?.status === 400) {
    return {
      message: "Invalid request to OpenAI. Please try a different message.",
      code: "INVALID_REQUEST",
      status: 400,
    };
  }

  if (error?.status >= 500) {
    return {
      message:
        "OpenAI service is currently unavailable. Please try again later.",
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    };
  }

  if (error?.code === "ENOTFOUND" || error?.code === "ECONNREFUSED") {
    return {
      message:
        "Unable to connect to OpenAI. Please check your internet connection.",
      code: "CONNECTION_ERROR",
      status: 503,
    };
  }

  return {
    message: "An unexpected error occurred while processing your message.",
    code: "UNKNOWN_ERROR",
    status: 500,
  };
}

async function sendPusherEvent(
  channel: string,
  event: string,
  data: any
): Promise<void> {
  try {
    await pusher.trigger(channel, event, data);
    console.log(`Pusher event sent: ${event}`);
  } catch (error) {
    console.error(`Failed to send Pusher event ${event}:`, error);
  }
}

async function generateMockResponse(
  message: string,
  messageId: string,
  sessionId: string
): Promise<string> {
  console.log("Generating mock response...");

  let mockResponse: string;

  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("hello") || lowerMessage.includes("hi")) {
    mockResponse =
      "Hello! This is a mock response. Your API is working correctly! How can I help you today?";
  } else if (lowerMessage.includes("test")) {
    mockResponse =
      "This is a test response. Your streaming API, Pusher integration, and error handling are all functioning properly.";
  } else if (lowerMessage.includes("how are you")) {
    mockResponse =
      "I'm doing well, thank you! This is a simulated response while you're in development mode.";
  } else {
    mockResponse = `You said: "${message}". This is a mock AI response to test your chat API. Everything is working correctly!`;
  }

  let assistantMessage = "";

  const words = mockResponse.split(" ");

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const chunk = i === 0 ? word : ` ${word}`;
    assistantMessage += chunk;

    const chunkData: PusherAssistantChunk = {
      messageId,
      content: assistantMessage,
      chunk,
      timestamp: new Date().toISOString(),
      isComplete: false,
      type: "assistant",
    };

    await sendPusherEvent(
      `chat-${sessionId}`,
      "assistant-message-chunk",
      chunkData
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return assistantMessage;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let sessionId: string | undefined;
  console.log("Chat API request received");

  try {
    const body = await request.json();
    console.log("Request parsed:", {
      hasMessage: !!body.message,
      hasSessionId: !!body.sessionId,
      messageLength: body.message?.length,
    });

    const validatedBody = validateRequestBody(body);
    const { message, sessionId: sid, userId } = validatedBody;
    sessionId = sid;

    console.log(`Processing message for session: ${sessionId}`);

    if (!conversations.has(sessionId)) {
      conversations.set(sessionId, [
        {
          role: "system",
          content:
            "You are a helpful AI assistant. Respond conversationally and be engaging.",
        },
      ]);
      console.log("Created new conversation");
    }

    const conversationHistory = conversations.get(sessionId)!;

    conversationHistory.push({
      role: "user",
      content: message,
    });

    console.log(`Conversation history length: ${conversationHistory.length}`);

    const userMessageData: PusherUserMessage = {
      message,
      userId: userId || "anonymous",
      timestamp: new Date().toISOString(),
      type: "user",
    };

    await sendPusherEvent(`chat-${sessionId}`, "user-message", userMessageData);

    const messageId = `msg_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    let assistantMessage = "";

    if (
      process.env.NODE_ENV === "development" &&
      process.env.MOCK_OPENAI === "true"
    ) {
      console.log("Using mock OpenAI response for testing...");
      assistantMessage = await generateMockResponse(
        message,
        messageId,
        sessionId
      );
    } else {
      console.log(`Calling OpenAI API...`);

      if (!openai) {
        throw new Error("OpenAI not initialized");
      }

      try {
        const stream = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: conversationHistory,
          stream: true,
          temperature: 0.7,
          max_tokens: 1000,
        });

        console.log("OpenAI stream created successfully");

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";

          if (content) {
            assistantMessage += content;

            const chunkData: PusherAssistantChunk = {
              messageId,
              content: assistantMessage,
              chunk: content,
              timestamp: new Date().toISOString(),
              isComplete: false,
              type: "assistant",
            };

            await sendPusherEvent(
              `chat-${sessionId}`,
              "assistant-message-chunk",
              chunkData
            );
          }
        }
      } catch (openaiError) {
        console.error("OpenAI API Error:", openaiError);

        const errorInfo = handleOpenAIError(openaiError);

        const errorNotification: PusherError = {
          error: errorInfo.message,
          timestamp: new Date().toISOString(),
          errorCode: errorInfo.code,
        };

        await sendPusherEvent(
          `chat-${sessionId}`,
          "service-error",
          errorNotification
        );

        const errorResponse: ErrorResponse = {
          error: errorInfo.message,
          errorCode: errorInfo.code,
          details:
            process.env.NODE_ENV === "development"
              ? String(openaiError)
              : undefined,
        };

        return NextResponse.json(errorResponse, {
          status: errorInfo.status,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }
    }

    console.log(`Generated response length: ${assistantMessage.length}`);

    if (!assistantMessage.trim()) {
      throw new Error("No response generated");
    }

    conversationHistory.push({
      role: "assistant",
      content: assistantMessage,
    });

    const completeData: PusherAssistantComplete = {
      messageId,
      content: assistantMessage,
      timestamp: new Date().toISOString(),
      isComplete: true,
      type: "assistant",
    };

    await sendPusherEvent(
      `chat-${sessionId}`,
      "assistant-message-complete",
      completeData
    );

    console.log("Chat response completed successfully");

    const response: SuccessResponse = {
      success: true,
      messageId,
      message: assistantMessage,
    };

    return NextResponse.json(response, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("General error processing message:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";

    const isValidationError =
      errorMessage.includes("required") ||
      errorMessage.includes("must be") ||
      errorMessage.includes("cannot be empty") ||
      errorMessage.includes("too long");

    if (sessionId) {
      const errorData: PusherError = {
        error: isValidationError ? errorMessage : "Failed to process message",
        timestamp: new Date().toISOString(),
        errorCode: isValidationError ? "VALIDATION_ERROR" : "PROCESSING_ERROR",
        details:
          process.env.NODE_ENV === "development" ? errorMessage : undefined,
      };

      await sendPusherEvent(`chat-${sessionId}`, "error", errorData);
    }

    const status = isValidationError ? 400 : 500;
    const errorResponse: ErrorResponse = {
      error: isValidationError ? errorMessage : "Failed to process message",
      errorCode: isValidationError ? "VALIDATION_ERROR" : "PROCESSING_ERROR",
      details:
        process.env.NODE_ENV === "development" ? errorMessage : undefined,
    };

    return NextResponse.json(errorResponse, {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}
