"use client";
import React, { useState, useEffect, useRef } from "react";
import Pusher from "pusher-js";

interface Message {
  id: string;
  type: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface PusherMessageData {
  message: string;
  userId: string;
  timestamp: string;
  type: "user" | "assistant";
}

interface PusherAssistantChunkData {
  messageId: string;
  content: string;
  chunk: string;
  timestamp: string;
  isComplete: boolean;
  type: "assistant";
}

interface PusherAssistantCompleteData {
  messageId: string;
  content: string;
  timestamp: string;
  isComplete: boolean;
  type: "assistant";
}

interface PusherErrorData {
  error: string;
  timestamp: string;
  details?: string;
}

interface SendMessageRequest {
  message: string;
  sessionId: string;
  userId: string;
}

interface SendMessageResponse {
  success: boolean;
  messageId: string;
  message: string;
}

const ChatInterface: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [sessionId] = useState<string>(
    () => `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  );
  const [currentAssistantMessage, setCurrentAssistantMessage] =
    useState<string>("");
  const [currentMessageId, setCurrentMessageId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pusherRef = useRef<Pusher | null>(null);
  const channelRef = useRef<any>(null);

  useEffect(() => {
    const pusherKey = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const pusherCluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

    if (!pusherKey || !pusherCluster) {
      console.error("Pusher configuration missing");
      return;
    }

    pusherRef.current = new Pusher(pusherKey, {
      cluster: pusherCluster,
      forceTLS: true,
    });

    channelRef.current = pusherRef.current.subscribe(`chat-${sessionId}`);

    channelRef.current.bind("user-message", (data: PusherMessageData) => {
      setMessages((prev: Message[]) => [
        ...prev,
        {
          id: `user_${Date.now()}`,
          type: "user",
          content: data.message,
          timestamp: data.timestamp,
        },
      ]);
    });
    channelRef.current.bind(
      "assistant-message-chunk",
      (data: PusherAssistantChunkData) => {
        setCurrentMessageId(data.messageId);
        setCurrentAssistantMessage(data.content);
      }
    );

    channelRef.current.bind(
      "assistant-message-complete",
      (data: PusherAssistantCompleteData) => {
        setMessages((prev: Message[]) => [
          ...prev,
          {
            id: data.messageId,
            type: "assistant",
            content: data.content,
            timestamp: data.timestamp,
          },
        ]);
        setCurrentAssistantMessage("");
        setCurrentMessageId(null);
        setIsLoading(false);
      }
    );

    channelRef.current.bind("error", (data: PusherErrorData) => {
      console.error("Chat error:", data);
      setIsLoading(false);
      alert("An error occurred. Please try again.");
    });

    return () => {
      if (channelRef.current && pusherRef.current) {
        pusherRef.current.unsubscribe(`chat-${sessionId}`);
      }
      if (pusherRef.current) {
        pusherRef.current.disconnect();
      }
    };
  }, [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentAssistantMessage]);

  const sendMessage = async (): Promise<void> => {
    if (!inputMessage.trim() || isLoading) return;

    const messageToSend = inputMessage.trim();
    setInputMessage("");
    setIsLoading(true);

    try {
      const requestBody: SendMessageRequest = {
        message: messageToSend,
        sessionId,
        userId: "user123",
      };

      const response = await fetch("/api/chat/send-message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to send message: ${response.status} ${errorText}`
        );
      }

      const responseData: SendMessageResponse = await response.json();
      console.log("Message sent successfully:", responseData);
    } catch (error) {
      console.error("Error sending message:", error);
      setIsLoading(false);
      alert("Failed to send message. Please try again.");
    }
  };

  const handleKeyPress = (
    e: React.KeyboardEvent<HTMLTextAreaElement>
  ): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleInputChange = (
    e: React.ChangeEvent<HTMLTextAreaElement>
  ): void => {
    setInputMessage(e.target.value);
  };

  return (
    <div>
      <div>
        <h1>AI Chat Assistant</h1>
        <p>Session: {sessionId.slice(-8)}</p>
      </div>

      <div>
        {messages.length === 0 && (
          <div>
            <p>👋 Welcome to AI Chat!</p>
            <p>Send a message to start the conversation.</p>
          </div>
        )}

        {messages.map((message: Message) => (
          <div key={message.id}>
            <div>
              <p>{message.content}</p>
              <p>{new Date(message.timestamp).toLocaleTimeString()}</p>
            </div>
          </div>
        ))}

        {currentAssistantMessage && (
          <div>
            <div>
              <p>{currentAssistantMessage}</p>
              <div>
                <div>
                  <div></div>
                  <div style={{ animationDelay: "0.1s" }}></div>
                  <div style={{ animationDelay: "0.2s" }}></div>
                </div>
                <span>AI is typing...</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div>
        <div>
          <textarea
            value={inputMessage}
            onChange={handleInputChange}
            onKeyPress={handleKeyPress}
            placeholder="Type your message..."
            rows={1}
            disabled={isLoading}
          />
          <button
            onClick={sendMessage}
            disabled={isLoading || !inputMessage.trim()}
            type="button"
          >
            {isLoading ? <div></div> : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;
