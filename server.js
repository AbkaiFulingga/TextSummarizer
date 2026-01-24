const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const pdfParse = require('pdf-parse');
const Busboy = require('busboy');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Simple in-memory storage for API key (in production, use environment variables)
let apiKey = process.env.HACKCLUB_API_KEY || '';

// Route to serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint for text summarization
app.post('/api/summarize', async (req, res) => {
    try {
        // Check if it's a file upload or text submission
        if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
            // Handle file upload
            const busboy = Busboy({ headers: req.headers });

            let fileData = null;
            let fileName = '';
            let fileSize = 0;
            const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit

            busboy.on('file', (fieldname, file, info) => {
                fileName = info.filename;
                fileSize = parseInt(info.encoding) || 0;

                // Check file size
                if (fileSize > MAX_FILE_SIZE) {
                    req.unpipe(); // Stop reading the request
                    return res.status(413).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.` });
                }

                const chunks = [];

                file.on('data', (chunk) => {
                    fileSize += chunk.length;

                    // Check file size during upload
                    if (fileSize > MAX_FILE_SIZE) {
                        req.unpipe(); // Stop reading the request
                        return res.status(413).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.` });
                    }

                    chunks.push(chunk);
                });

                file.on('end', () => {
                    fileData = Buffer.concat(chunks);
                });
            });

            busboy.on('field', (fieldname, val) => {
                // Handle any additional fields if needed
                console.log('Field', fieldname, val);
            });

            busboy.on('error', (err) => {
                console.error('Busboy error:', err);
                res.status(500).json({ error: 'Error processing file upload: ' + err.message });
            });

            busboy.on('finish', async () => {
                if (!fileData) {
                    return res.status(400).json({ error: 'No file uploaded' });
                }

                // Validate file extension
                const fileExtension = path.extname(fileName).toLowerCase();

                try {
                    let textContent = '';

                    if (fileExtension === '.pdf') {
                        // Parse .PDF content
                        const pdfData = await pdfParse(fileData);
                        textContent = pdfData.text;
                    } else if (fileExtension === '.docx') {
                        // Parse .DOCX content
                        const result = await mammoth.extractRawText({ buffer: fileData });
                        textContent = result.value;
                    } else if (fileExtension === '.txt') {
                        // Parse .TXT content
                        textContent = fileData.toString('utf8');
                    } else {
                        return res.status(400).json({ error: 'Unsupported file format. Supported formats: PDF, DOCX, TXT' });
                    }

                    if (!textContent || textContent.trim().length < 50) {
                        return res.status(400).json({ error: 'File does not contain enough text to summarize (minimum 50 characters)' });
                    }

                    // Summarize the extracted text
                    const summary = await getSummaryFromAI(textContent);
                    res.json({ summary });
                } catch (error) {
                    console.error('File processing error:', error);
                    res.status(500).json({ error: 'Error processing file: ' + error.message });
                }
            });

            req.pipe(busboy);
        } else {
            // Handle text submission
            const { text, language, summaryLength } = req.body;

            // Validate request body
            if (!req.body || typeof req.body !== 'object') {
                return res.status(400).json({ error: 'Invalid request body' });
            }

            if (!text) {
                return res.status(400).json({ error: 'No text provided for summarization' });
            }

            if (typeof text !== 'string') {
                return res.status(400).json({ error: 'Text must be a string' });
            }

            // Sanitize input to prevent injection attacks
            const sanitizedText = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

            if (sanitizedText.trim().length < 50) {
                return res.status(400).json({ error: 'Please provide at least 50 characters for meaningful summarization' });
            }

            if (sanitizedText.length > 10000) { // Limit text length
                return res.status(400).json({ error: 'Text is too long. Maximum length is 10,000 characters.' });
            }

            // Summarize the provided text
            const summary = await getSummaryFromAI(sanitizedText, language, summaryLength);
            res.json({ summary });
        }
    } catch (error) {
        console.error('Summarization error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

// Function to get summary from AI API
async function getSummaryFromAI(text, language = 'english', summaryLength = 'medium') {
    // Check if we have an API key
    if (!apiKey) {
        console.warn('No API key provided. Using mock summarization.');
        return mockSummarization(text, language, summaryLength);
    }

    // Determine max tokens based on summary length, more tokens for longer summaries
    let maxTokens;
    switch(summaryLength) {
        case 'short':
            maxTokens = 100;
            break;
        case 'long':
            maxTokens = 400;
            break;
        case 'medium':
        default:
            maxTokens = 200;
            break;
    }

    try {
        // Making a request to the HackClub AI API
        const response = await fetch('https://ai.hackclub.com/proxy/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "openai/gpt-5.2",
                messages: [{
                    role: "user",
                    content: `Please summarize the following text in ${language}. Make the summary ${summaryLength} length:\n\n${text}`
                }],
                max_tokens: maxTokens, // Limit the response length based on user preference
                temperature: 0.5 // Control randomness
            })
        });

        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        // Extract the summary from the response
        if (data.choices && data.choices.length > 0) {
            return data.choices[0].message.content.trim();
        } else {
            throw new Error('Invalid response format from AI API');
        }
    } catch (error) {
        console.error('AI API error:', error);

        // Log the specific error for debugging
        if (error.code === 'ENOTFOUND') {
            console.error('Could not reach the AI API server. Please check your connection and API endpoint.');
        } else if (error.status === 401) {
            console.error('Invalid API key. Please check your HACKCLUB_API_KEY environment variable.');
        } else if (error.status === 429) {
            console.error('Rate limit exceeded. Please try again later.');
        }

        // Fallback to mock summarization if API fails
        return mockSummarization(text, language, summaryLength);
    }
}

// Mock summarization function for demonstration purposes
function mockSummarization(text, language = 'english', summaryLength = 'medium') {
    // This is a very basic mock summarization
    // In reality, this would be replaced with actual AI processing
    const sentences = text.match(/[^\.!?]+[\.!?]+/g) || [text];

    if (sentences.length <= 3) {
        let lengthLimit;
        switch(summaryLength) {
            case 'short':
                lengthLimit = 100;
                break;
            case 'long':
                lengthLimit = 400;
                break;
            case 'medium':
            default:
                lengthLimit = 200;
                break;
        }
        return text.substring(0, lengthLimit) + (text.length > lengthLimit ? '...' : '');
    }

    let summary;

    // Adjust summary length based on user preference, medium by default
    switch(summaryLength) {
        case 'short':
            // Take only the first sentence
            summary = sentences[0] ? sentences[0].trim() : '';
            break;
        case 'long':
            // Take first, middle, last, and a few more sentences
            const indices = [0, Math.floor(sentences.length / 4), Math.floor(sentences.length / 2),
                             Math.floor(3 * sentences.length / 4), sentences.length - 1];
            summary = [...new Set(indices)]
                .map(i => sentences[i] ? sentences[i].trim() : '')
                .filter(s => s.length > 0)
                .join(' ');
            break;
        case 'medium':
        default:
            // Take the first, middle, and last sentences as a simple summary
            const first = sentences[0] ? sentences[0].trim() : '';
            const middle = sentences[Math.floor(sentences.length / 2)] ? sentences[Math.floor(sentences.length / 2)].trim() : '';
            const last = sentences[sentences.length - 1] ? sentences[sentences.length - 1].trim() : '';

            summary = [first, middle, last]
                .filter(s => s.length > 0)
                .join(' ');
            break;
    }

    // Limit length to prevent extremely long summaries
    let maxLength;
    switch(summaryLength) {
        case 'short':
            maxLength = 150;
            break;
        case 'long':
            maxLength = 500;
            break;
        case 'medium':
        default:
            maxLength = 300;
            break;
    }

    if (summary.length > maxLength) {
        summary = summary.substring(0, maxLength) + '...';
    }

    return summary || 'Summary could not be generated from the provided text.';
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Access the application at http://localhost:${PORT}`);
});

module.exports = app;