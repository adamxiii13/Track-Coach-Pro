import { GoogleGenAI } from "@google/genai";

export async function generateAppIcon() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  
  const prompt = "A professional and modern app icon for a track and field timing application called 'Track Coach Pro'. The icon should feature a stylized, minimalist stopwatch integrated with track lanes. Use a vibrant emerald green and deep charcoal gray color palette. Flat design with subtle depth, high contrast, suitable for a mobile app home screen. Clean lines, professional aesthetic, square format with rounded corners.";

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [
          {
            text: prompt,
          },
        ],
      },
      config: {
        imageConfig: {
          aspectRatio: "1:1",
        },
      },
    });

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
  } catch (error) {
    console.error("Error generating icon:", error);
    return null;
  }
}
