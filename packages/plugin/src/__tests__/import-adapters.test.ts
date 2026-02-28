import { describe, expect, test } from "bun:test";
import { parseChatGptConversations } from "../import/adapters/chatgpt";
import { parseClaudeConversations } from "../import/adapters/claude";
import { parseGrokConversations } from "../import/adapters/grok";

describe("import adapters", () => {
  test("chatgpt adapter flattens mapping tree using current_node path", () => {
    const raw = [
      {
        id: "chatgpt-conv-1",
        title: "Importer planning",
        create_time: 1704067200,
        update_time: 1704067500,
        current_node: "node-4",
        mapping: {
          "node-1": {
            id: "node-1",
            message: {
              id: "m1",
              author: { role: "system" },
              create_time: 1704067200,
              content: { content_type: "text", parts: ["System context"] },
            },
            children: ["node-2"],
          },
          "node-2": {
            id: "node-2",
            parent: "node-1",
            message: {
              id: "m2",
              author: { role: "user" },
              create_time: 1704067210,
              content: { content_type: "text", parts: ["Plan the importer"] },
            },
            children: ["node-3", "node-5"],
          },
          "node-3": {
            id: "node-3",
            parent: "node-2",
            message: {
              id: "m3",
              author: { role: "assistant" },
              create_time: 1704067220,
              content: { content_type: "text", parts: ["Old draft"] },
            },
          },
          "node-5": {
            id: "node-5",
            parent: "node-2",
            message: {
              id: "m5",
              author: { role: "assistant" },
              create_time: 1704067230,
              content: { content_type: "text", parts: ["Revised draft"] },
            },
            children: ["node-4"],
          },
          "node-4": {
            id: "node-4",
            parent: "node-5",
            message: {
              id: "m4",
              author: { role: "user" },
              create_time: 1704067240,
              content: { content_type: "text", parts: ["Looks good"] },
            },
          },
        },
      },
    ];

    const conversations = parseChatGptConversations(raw);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.conversationId).toBe("chatgpt-conv-1");
    expect(conversations[0]?.title).toBe("Importer planning");
    expect(conversations[0]?.messages.map((message) => message.id)).toEqual(["m1", "m2", "m5", "m4"]);
  });

  test("chatgpt adapter infers parent chain from children pointers", () => {
    const raw = [
      {
        id: "chatgpt-conv-2",
        title: "Missing parent links",
        create_time: 1_000_000_000_000,
        current_node: "node-3",
        mapping: {
          "node-1": {
            id: "node-1",
            message: {
              id: "m1",
              author: { role: "system" },
              content: { parts: ["System"] },
            },
            children: ["node-2"],
          },
          "node-2": {
            id: "node-2",
            message: {
              id: "m2",
              author: { role: "user" },
              content: { parts: ["Question"] },
            },
            children: ["node-3"],
          },
          "node-3": {
            id: "node-3",
            message: {
              id: "m3",
              author: { role: "assistant" },
              content: { parts: ["Answer"] },
            },
          },
        },
      },
    ];

    const conversations = parseChatGptConversations(raw);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.createdAt).toBe("2001-09-09T01:46:40.000Z");
    expect(conversations[0]?.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("claude adapter parses chat_messages exports", () => {
    const raw = {
      conversations: [
        {
          uuid: "claude-conv-1",
          name: "Claude planning",
          created_at: "2024-01-01T00:00:00.000Z",
          updated_at: "2024-01-01T00:04:00.000Z",
          chat_messages: [
            {
              uuid: "c1",
              sender: "human",
              text: "Summarize this project",
              created_at: "2024-01-01T00:01:00.000Z",
            },
            {
              uuid: "c2",
              sender: "assistant",
              content: [{ type: "text", text: "Here is a summary." }],
              created_at: "2024-01-01T00:02:00.000Z",
            },
          ],
        },
      ],
    };

    const conversations = parseClaudeConversations(raw);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.conversationId).toBe("claude-conv-1");
    expect(conversations[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(conversations[0]?.messages[1]?.content).toBe("Here is a summary.");
  });

  test("grok adapter handles Mongo $date.$numberLong timestamps", () => {
    const raw = {
      data: [
        {
          _id: { $oid: "grok-conv-1" },
          title: "Grok export",
          createdAt: { $date: { $numberLong: "1704067200000" } },
          updatedAt: { $date: { $numberLong: "1704067500000" } },
          messages: [
            {
              _id: { $oid: "g1" },
              role: "user",
              content: "Need migration notes",
              createdAt: { $date: { $numberLong: "1704067210000" } },
            },
            {
              _id: { $oid: "g2" },
              role: "assistant",
              content: [{ type: "text", text: "Migration notes ready." }],
              createdAt: { $date: { $numberLong: "1704067220000" } },
            },
          ],
        },
      ],
    };

    const conversations = parseGrokConversations(raw);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.conversationId).toBe("grok-conv-1");
    expect(conversations[0]?.updatedAt).toBe("2024-01-01T00:05:00.000Z");
    expect(conversations[0]?.messages.map((message) => message.id)).toEqual(["g1", "g2"]);
  });

  test("grok adapter also parses ISO-8601 timestamps", () => {
    const raw = [
      {
        id: "grok-conv-iso",
        title: "ISO export",
        createdAt: "2024-02-01T00:00:00.000Z",
        updatedAt: "2024-02-01T00:03:00.000Z",
        messages: [
          {
            id: "iso-1",
            role: "user",
            content: "hello",
            createdAt: "2024-02-01T00:01:00.000Z",
          },
          {
            id: "iso-2",
            role: "assistant",
            content: "world",
            createdAt: "2024-02-01T00:02:00.000Z",
          },
        ],
      },
    ];

    const conversations = parseGrokConversations(raw);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.updatedAt).toBe("2024-02-01T00:03:00.000Z");
    expect(conversations[0]?.messages.map((message) => message.id)).toEqual(["iso-1", "iso-2"]);
  });
});
