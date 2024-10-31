import { Groq } from 'groq-sdk';
import { NextResponse } from 'next/server';

// Initialize GROQ with API key from environment variable
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

export async function POST(request: Request) {
  try {
    const { messages, searchContext, base64Image } = await request.json();

    const formattedMessages = [];

    // Add system message and search context
    formattedMessages.push({
      role: "user",
      content: `You are an AI assistant helping to analyze and discuss content from a whiteboard. The user's query is related to the following content found on the whiteboard, make sense of it and assume that this part is just text extracted from the whiteboard - ignore gibberish and do not mention how many times something occurs or describe the context:\n\n${searchContext}. Do not respond with any formatting or markdown.`
    });

    // Add conversation history
    formattedMessages.push(...messages.map((msg: any) => ({
      role: msg.role,
      content: msg.content
    })));

    // Add image if available
    if (base64Image) {
      formattedMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "Here is the relevant section of the whiteboard:" + searchContext
          },
          {
            type: "image_url",
            image_url: {
              url: base64Image
            }
          }
        ]
      });
    }

    const completion = await groq.chat.completions.create({
      messages: formattedMessages,
      model: "llama-3.2-11b-vision-preview",
      max_tokens: 2048,
      stream: false
    });

    return NextResponse.json({
      content: completion.choices[0]?.message?.content || 'No response generated'
    });

  } catch (error: any) {
    console.error('Chat API error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to generate response' },
      { status: 500 }
    );
  }
}