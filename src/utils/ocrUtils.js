/**
 * OCR & Document Processing Utilities
 * Client-side PDF rendering and text extraction using pdfjs-dist + tesseract.js
 */

import * as pdfjs from 'pdfjs-dist'

// Configure PDF.js worker (CDN for static deployment compatibility)
pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`

/**
 * Load Tesseract.js dynamically to avoid bundling issues
 */
let Tesseract = null

async function loadTesseract() {
  if (!Tesseract) {
    const module = await import('tesseract.js')
    Tesseract = module.default || module
  }
  return Tesseract
}

/**
 * Extract all pages from a PDF file as image data URLs
 * @param {File} file - PDF file
 * @param {Function} onProgress - Callback(pageIndex, totalPages, stage)
 * @returns {Promise<Array<{pageNum: number, imageUrl: string, width: number, height: number}>>}
 */
export async function extractPdfPages(file, onProgress = () => {}) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise
  const totalPages = pdf.numPages
  const pages = []

  for (let i = 1; i <= totalPages; i++) {
    onProgress(i, totalPages, 'rendering')
    const page = await pdf.getPage(i)

    // Render at 2.5x scale for better OCR accuracy
    const scale = 2.5
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    canvas.width = viewport.width
    canvas.height = viewport.height

    // White background (some PDFs have transparent backgrounds)
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    await page.render({
      canvasContext: ctx,
      viewport: viewport
    }).promise

    const imageUrl = canvas.toDataURL('image/png')
    pages.push({
      pageNum: i,
      imageUrl,
      width: canvas.width,
      height: canvas.height,
      canvas
    })

    page.cleanup()
  }

  return pages
}

/**
 * Check if PDF already has embedded text (skip OCR if it does)
 * @param {File} file - PDF file
 * @returns {Promise<boolean>}
 */
export async function hasEmbeddedText(file) {
  try {
    const arrayBuffer = await file.arrayBuffer()
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise
    const page = await pdf.getPage(1)
    const textContent = await page.getTextContent()
    return textContent.items.length > 5 // At least 5 text items
  } catch {
    return false
  }
}

/**
 * Extract text from a single page image using Tesseract.js
 * @param {HTMLCanvasElement|HTMLImageElement|string} image - Image source
 * @param {string} language - OCR language (default: 'eng')
 * @param {Function} onProgress - Callback for OCR progress
 * @returns {Promise<{text: string, confidence: number, words: Array}>}
 */
export async function ocrPage(image, language = 'eng', onProgress = () => {}) {
  const T = await loadTesseract()

  const worker = await T.createWorker(language)

  const result = await worker.recognize(image, {}, {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        onProgress(m.progress)
      }
    }
  })

  await worker.terminate()

  return {
    text: result.data.text,
    confidence: result.data.confidence,
    words: result.data.words || [],
    lines: result.data.lines || []
  }
}

/**
 * Extract embedded text from PDF (no OCR needed)
 * @param {File} file - PDF file
 * @param {Function} onProgress - Callback(pageIndex, totalPages)
 * @returns {Promise<Array<{pageNum: number, text: string, words: Array}>>}
 */
export async function extractPdfText(file, onProgress = () => {}) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise
  const totalPages = pdf.numPages
  const results = []

  for (let i = 1; i <= totalPages; i++) {
    onProgress(i, totalPages)
    const page = await pdf.getPage(i)
    const textContent = await page.getTextContent()

    const text = textContent.items.map(item => item.str).join(' ')
    const words = textContent.items.map((item, idx) => ({
      text: item.str,
      bbox: item.transform ? {
        x0: item.transform[4],
        y0: item.transform[5],
        x1: item.transform[4] + (item.width || 50),
        y1: item.transform[5] + (item.height || 12)
      } : null,
      confidence: 100
    }))

    results.push({
      pageNum: i,
      text,
      words,
      confidence: 100
    })

    page.cleanup()
  }

  return results
}

/**
 * Process image file (PNG, JPG, etc.) - single page
 * @param {File} file - Image file
 * @returns {Promise<{pageNum: number, imageUrl: string, width: number, height: number}>}
 */
export async function processImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        resolve({
          pageNum: 1,
          imageUrl: e.target.result,
          width: img.width,
          height: img.height
        })
      }
      img.onerror = reject
      img.src = e.target.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/**
 * Generate a cropped snippet from a page image based on bounding box coordinates
 * @param {string} imageUrl - Full page image URL
 * @param {Object} bbox - Bounding box {x0, y0, x1, y1}
 * @param {number} pageWidth - Original page width
 * @param {number} pageHeight - Original page height
 * @param {number} padding - Padding in pixels (default: 20)
 * @returns {Promise<string>} - Cropped image data URL
 */
export async function generateCroppedSnippet(imageUrl, bbox, pageWidth, pageHeight, padding = 20) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')

      // Calculate crop coordinates with padding
      const scaleX = img.width / pageWidth
      const scaleY = img.height / pageHeight

      const x = Math.max(0, (bbox.x0 * scaleX) - padding)
      const y = Math.max(0, (bbox.y0 * scaleY) - padding)
      const w = Math.min(img.width - x, ((bbox.x1 - bbox.x0) * scaleX) + (padding * 2))
      const h = Math.min(img.height - y, ((bbox.y1 - bbox.y0) * scaleY) + (padding * 2))

      canvas.width = w
      canvas.height = h

      // White background
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, w, h)

      ctx.drawImage(img, x, y, w, h, 0, 0, w, h)

      // Draw red border around the detected area
      const borderX = padding * scaleX
      const borderY = padding * scaleY
      const borderW = (bbox.x1 - bbox.x0) * scaleX
      const borderH = (bbox.y1 - bbox.y0) * scaleY

      ctx.strokeStyle = '#ef4444'
      ctx.lineWidth = 3
      ctx.strokeRect(borderX, borderY, borderW, borderH)

      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = reject
    img.src = imageUrl
  })
}

/**
 * Parse engineering/architectural data from extracted text
 * This is a rule-based parser that identifies common patterns in engineering docs
 * @param {string} text - Raw extracted text
 * @param {number} pageNum - Page number
 * @param {Array} words - Word objects with bounding boxes
 * @returns {Array} - Array of extracted data items
 */
export function parseEngineeringData(text, pageNum, words = []) {
  const items = []
  const lines = text.split('\n').filter(l => l.trim())

  // Pattern definitions for engineering/architectural documents
  const patterns = [
    {
      type: 'Dimension',
      regex: /(\d+[\.,]?\d*)\s*(mm|cm|m|ft|in|inch|inches|\')/gi,
      extractor: (match) => ({
        value: match[1],
        unit: match[2],
        raw: match[0]
      })
    },
    {
      type: 'Area',
      regex: /(\d+[\.,]?\d*)\s*(m²|sq\s*m|sqm|ft²|sq\s*ft|sqft)/gi,
      extractor: (match) => ({
        value: match[1],
        unit: match[2],
        raw: match[0]
      })
    },
    {
      type: 'Volume',
      regex: /(\d+[\.,]?\d*)\s*(m³|cubic\s*m|cu\s*m|ft³|cubic\s*ft|cu\s*ft)/gi,
      extractor: (match) => ({
        value: match[1],
        unit: match[2],
        raw: match[0]
      })
    },
    {
      type: 'Load/Force',
      regex: /(\d+[\.,]?\d*)\s*(kN|N|kips|lbs|tons?)/gi,
      extractor: (match) => ({
        value: match[1],
        unit: match[2],
        raw: match[0]
      })
    },
    {
      type: 'Pressure/Stress',
      regex: /(\d+[\.,]?\d*)\s*(MPa|kPa|Pa|psi|ksi|bar)/gi,
      extractor: (match) => ({
        value: match[1],
        unit: match[2],
        raw: match[0]
      })
    },
    {
      type: 'Material Spec',
      regex: /(concrete|steel|rebar|reinforcement|timber|wood|brick|masonry|aluminum|glass)\s*(grade|class|type)?\s*[:\-]?\s*(\w+)/gi,
      extractor: (match) => ({
        material: match[1],
        grade: match[3],
        raw: match[0]
      })
    },
    {
      type: 'Column/Beam ID',
      regex: /(column|beam|col\.?|bm\.?|b\.?)\s*[:\-]?\s*([A-Z]-?\d+|\d+[A-Z]?)/gi,
      extractor: (match) => ({
        element: match[1],
        identifier: match[2],
        raw: match[0]
      })
    },
    {
      type: 'Elevation',
      regex: /(elevation|el\.?|level|fl\.?|floor)\s*[:\-]?\s*([\+\-]?\d+[\.,]?\d*)/gi,
      extractor: (match) => ({
        type: match[1],
        value: match[2],
        raw: match[0]
      })
    },
    {
      type: 'Rebar Detail',
      regex: /(\d+)\s*[xX]\s*(\d+[\.,]?\d*)\s*(mm|#)?\s*(dia\.?|diameter|Ø|\u00D8)?/gi,
      extractor: (match) => ({
        quantity: match[1],
        diameter: match[2],
        unit: match[3] || 'mm',
        raw: match[0]
      })
    },
    {
      type: 'Drawing Reference',
      regex: /(drawing|drg|detail|section|plan)\s*[:\-]?\s*([A-Z]?\d+[\-\/]?\d*)/gi,
      extractor: (match) => ({
        type: match[1],
        reference: match[2],
        raw: match[0]
      })
    }
  ]

  patterns.forEach(pattern => {
    let match
    const regex = new RegExp(pattern.regex.source, 'gi')

    while ((match = regex.exec(text)) !== null) {
      // Find the word closest to this match position
      const matchStart = match.index
      const matchEnd = match.index + match[0].length

      // Find bounding box from words array
      let bbox = null
      let matchedWords = []

      if (words && words.length > 0) {
        // Find words that overlap with this match
        const textBeforeMatch = text.substring(0, matchStart)
        const matchText = match[0]

        // Approximate word matching
        let currentPos = 0
        for (let i = 0; i < words.length; i++) {
          const word = words[i]
          const wordText = word.text || word.str || ''
          const wordStart = text.indexOf(wordText, currentPos)
          const wordEnd = wordStart + wordText.length

          if (wordStart >= matchStart - 5 && wordEnd <= matchEnd + 5) {
            matchedWords.push(word)
            if (!bbox && word.bbox) {
              bbox = { ...word.bbox }
            } else if (word.bbox) {
              bbox.x0 = Math.min(bbox.x0, word.bbox.x0)
              bbox.y0 = Math.min(bbox.y0, word.bbox.y0)
              bbox.x1 = Math.max(bbox.x1, word.bbox.x1)
              bbox.y1 = Math.max(bbox.y1, word.bbox.y1)
            }
            currentPos = wordEnd
          }
        }
      }

      // If no bbox from words, estimate from line position
      if (!bbox) {
        const lineIndex = lines.findIndex(line => line.includes(match[0]))
        if (lineIndex >= 0) {
          bbox = {
            x0: 50,
            y0: lineIndex * 25 + 50,
            x1: 50 + match[0].length * 8,
            y1: lineIndex * 25 + 75
          }
        } else {
          bbox = { x0: 50, y0: 50, x1: 200, y1: 100 }
        }
      }

      const extracted = pattern.extractor(match)

      items.push({
        id: `page${pageNum}_item${items.length + 1}`,
        pageNum,
        type: pattern.type,
        ...extracted,
        bbox,
        lineContext: lines.find(line => line.includes(match[0])) || match[0],
        confidence: 85,
        timestamp: Date.now()
      })
    }
  })

  return items
}

/**
 * Generate a unique identifier for each extracted item
 * Ensures NO deduplication - every item gets its own ID
 * @param {Array} items - Array of extracted items
 * @returns {Array} - Items with guaranteed unique IDs
 */
export function ensureUniqueItems(items) {
  return items.map((item, index) => ({
    ...item,
    id: `${item.id || 'item'}_${index}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    sequenceNumber: index + 1
  }))
}
