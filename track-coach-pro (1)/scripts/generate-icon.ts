import { GoogleGenAI } from "@google/genai";
import fs from "fs";

async function generateAndSaveIcon() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  
  const prompt = "A professional and modern app icon for a track and field timing application called 'Track Coach Pro'. The icon should feature a stylized, minimalist stopwatch integrated with track lanes. Use a vibrant emerald green and deep charcoal gray color palette. Flat design with high contrast, suitable for a mobile app home screen. Clean lines, professional aesthetic, square format with rounded corners.";

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: prompt }],
      },
      config: {
        imageConfig: {
          aspectRatio: "1:1",
        },
      },
    });

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const base64Data = part.inlineData.data;
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync('public/favicon.png', buffer);
        console.log("Icon saved successfully to public/favicon.png");
        return;
      }
    }
  } catch (error) {
    console.error("Error generating icon:", error);
  }
}

generateAndSaveIcon();
