const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { db, bcrypt } = require("./database");

const PORT = 3000;
const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "llama3.2:3b";

// Temporary login sessions.
// User data itself is stored permanently in SQLite.
const sessions = new Map();


// ==========================================
// ADD UPDATED_AT COLUMN IF NEEDED
// ==========================================

try {

  const columns = db.prepare(`
    PRAGMA table_info(presentations)
  `).all();

  const hasUpdatedAt =
    columns.some(column => column.name === "updated_at");

  if (!hasUpdatedAt) {

    db.exec(`
      ALTER TABLE presentations
      ADD COLUMN updated_at DATETIME
    `);

    db.exec(`
      UPDATE presentations
      SET updated_at = created_at
      WHERE updated_at IS NULL
    `);

    console.log("Added updated_at column to presentations.");

  }

} catch (error) {

  console.error(
    "Database migration warning:",
    error.message
  );

}


// ==========================================
// JSON RESPONSE
// ==========================================

function sendJSON(res, status, data, extraHeaders = {}) {

  res.writeHead(status, {

    "Content-Type":
      "application/json; charset=utf-8",

    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Headers":
      "Content-Type",

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    ...extraHeaders

  });

  res.end(
    JSON.stringify(data)
  );

}


// ==========================================
// REQUEST BODY
// ==========================================

function getBody(req) {

  return new Promise((resolve, reject) => {

    let body = "";

    req.on("data", chunk => {

      body += chunk;

      if (body.length > 5 * 1024 * 1024) {

        reject(
          new Error("Request too large.")
        );

        req.destroy();

      }

    });

    req.on("end", () => {

      try {

        resolve(
          JSON.parse(body || "{}")
        );

      } catch {

        reject(
          new Error("Invalid JSON request.")
        );

      }

    });

    req.on("error", reject);

  });

}


// ==========================================
// COOKIES
// ==========================================

function parseCookies(req) {

  const cookies = {};

  const header =
    req.headers.cookie;

  if (!header) {

    return cookies;

  }

  header
    .split(";")
    .forEach(cookie => {

      const index =
        cookie.indexOf("=");

      if (index === -1) return;

      const key =
        cookie.slice(0, index).trim();

      const value =
        cookie.slice(index + 1).trim();

      cookies[key] =
        decodeURIComponent(value);

    });

  return cookies;

}


// ==========================================
// CURRENT USER
// ==========================================

function getCurrentUser(req) {

  const cookies =
    parseCookies(req);

  const token =
    cookies.session;

  if (!token) {

    return null;

  }

  const userId =
    sessions.get(token);

  if (!userId) {

    return null;

  }

  const user =
    db.prepare(`
      SELECT
        id,
        name,
        email,
        created_at
      FROM users
      WHERE id = ?
    `).get(userId);

  return user || null;

}


// ==========================================
// SESSION
// ==========================================

function createSession(userId) {

  const token =
    crypto.randomBytes(32).toString("hex");

  sessions.set(
    token,
    userId
  );

  return token;

}


// ==========================================
// CLEAN AI JSON
// ==========================================

function cleanJSON(text) {

  let result =
    text.trim();

  result =
    result
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

  const first =
    result.indexOf("{");

  const last =
    result.lastIndexOf("}");

  if (
    first !== -1 &&
    last !== -1
  ) {

    result =
      result.slice(
        first,
        last + 1
      );

  }

  return result;

}


// ==========================================
// OLLAMA
// ==========================================

async function callOllama(prompt) {

  const response =
    await fetch(
      OLLAMA_URL,
      {

        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({

          model: MODEL,

          prompt: prompt,

          stream: false,

          format: "json",

          options: {

            temperature: 0.7,

            num_ctx: 8192

          }

        })

      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      "Ollama request failed: " +
      errorText
    );

  }

  const data =
    await response.json();

  if (!data.response) {

    throw new Error(
      "Ollama returned an empty response."
    );

  }

  return data.response;

}


// ==========================================
// GENERATE PRESENTATION
// ==========================================

async function generatePresentation(body) {

  const topic = String(body.topic || "").trim();
  const notes = String(body.notes || "").trim();

  const slideCount =
    Math.min(
      Math.max(Number(body.slideCount) || 8, 3),
      12
    );

  const audience =
    body.audience || "College students";

  const style =
    body.style || "Modern professional";

  const selectedTheme =
    body.presentationTheme || "neon";

  if (!topic && !notes) {
    throw new Error("Please enter a topic or presentation content.");
  }

  const sourceContent = notes || topic;

  const prompt = `
You are PreGenerator AI, an expert presentation designer.

You must intelligently analyze the user's input and convert it into a complete professional presentation.

IMPORTANT:
The user may provide:
- only a topic
- bullet points
- paragraphs
- notes
- headings
- raw study material
- copied content
- mixed text

Do NOT simply copy the user's text.

Analyze the meaning and create a logical presentation.

TOPIC:
${topic || "Infer the topic from the provided content."}

USER CONTENT:
${sourceContent}

AUDIENCE:
${audience}

DESIGN STYLE:
${style}

USER SELECTED THEME:
${selectedTheme}

SLIDE COUNT:
${slideCount}

CONTENT ANALYSIS RULES:

1. Understand the complete user content before creating slides.
2. Extract the important concepts from the content.
3. Group related information together.
4. Convert long paragraphs into short presentation-friendly points.
5. Do not lose important information from the user's content.
6. Do not invent facts, statistics, names, dates or sources.
7. If the user gives headings, use them intelligently.
8. If the user gives bullet points, analyze their meaning instead of blindly copying them.
9. Every slide must have one clear purpose.
10. Create a strong beginning, logical middle and useful conclusion.
11. Use concise bullets.
12. Avoid large paragraphs.
13. Use different visual structures between slides.
14. Choose a visual that actually matches the slide topic.
15. Every slide should have DIFFERENT visual keywords when possible.
16. Do not use the same image concept on every slide.

VISUAL ANALYSIS:

For every slide, identify the actual subject.

Examples:

Computer Science:
AI, neural network, computer, coding, database, cybersecurity, cloud, robot

Biology:
cell, DNA, microscope, human body, ecosystem, plant, laboratory

Electrical:
circuit, transformer, motor, generator, electricity, power grid

Business:
teamwork, marketing, finance, growth, analytics, startup

Education:
students, classroom, learning, books, teacher, examination

Environment:
forest, climate, renewable energy, pollution, solar, nature

Engineering:
machine, robotics, mechanical system, construction, technology

History:
monument, ancient architecture, historical objects, culture

The visualKeywords MUST describe the actual subject of that slide.

LAYOUT OPTIONS:

hero
two-column
cards
timeline
process
comparison
quote
stats
image-focus
problem-solution
architecture

VISUAL OPTIONS:

photo
illustration
icon
diagram
chart
timeline
none

Return ONLY valid JSON.

Use EXACTLY this structure:

{
  "presentationTitle": "string",
  "presentationSubtitle": "string",
  "theme": {
    "name": "string",
    "primaryColor": "#2563EB",
    "secondaryColor": "#7C3AED",
    "accentColor": "#06B6D4",
    "backgroundColor": "#FFFFFF",
    "fontStyle": "Modern Sans"
  },
  "slides": [
    {
      "slideNumber": 1,
      "title": "string",
      "subtitle": "string",
      "bullets": [
        "short point",
        "short point",
        "short point"
      ],
      "layout": "hero",
      "visualType": "photo",
      "visualKeywords": [
        "specific subject",
        "specific concept",
        "specific visual"
      ],
      "designNote": "short design instruction"
    }
  ]
}

Make exactly ${slideCount} slides.

Slide 1 MUST use "hero".

Later slides MUST use varied layouts.

Each slide should have content-specific visualKeywords.

Do not put markdown outside the JSON.
`;

  const raw = await callOllama(prompt);

  const cleaned = cleanJSON(raw);

  let result;

  try {
    result = JSON.parse(cleaned);
  } catch (error) {
    console.error("Invalid AI JSON:", raw);

    throw new Error(
      "Local AI returned invalid presentation data. Please try again."
    );
  }

  if (!result.slides || !Array.isArray(result.slides)) {
    throw new Error(
      "AI response does not contain slides."
    );
  }

  // Make sure every slide has visual keywords.
  result.slides = result.slides.map((slide, index) => {

    if (!Array.isArray(slide.visualKeywords)) {
      slide.visualKeywords = [
        topic || "presentation",
        slide.title || "concept",
        "creative"
      ];
    }

    return {
      ...slide,
      slideNumber: index + 1
    };
  });

  return result;
}


// ==========================================
// SERVER
// ==========================================
async function proxyImage(url, res) {
  try {
    const parsed = new URL(url);

    // Only allow Pollinations images
    if (parsed.hostname !== "image.pollinations.ai") {
      res.writeHead(400, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: false,
        error: "Invalid image source"
      }));
      return;
    }

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error("Image service returned " + response.status);
    }

    const contentType =
      response.headers.get("content-type") ||
      "image/jpeg";

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*"
    });

    res.end(buffer);

  } catch (error) {

    console.error(
      "Image proxy error:",
      error.message
    );

    res.writeHead(500, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      success: false,
      error: "Could not load image"
    }));
  }
}

const server =
  http.createServer(
    async (req, res) => {

// ==========================================
// IMAGE PROXY
// ==========================================

if (
  req.method === "GET" &&
  req.url.startsWith("/api/image-proxy")
) {

  const requestURL = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  const imageURL =
    requestURL.searchParams.get("url");

  if (!imageURL) {

    sendJSON(
      res,
      400,
      {
        success: false,
        error: "Missing image URL"
      }
    );

    return;
  }

  await proxyImage(
    imageURL,
    res
  );

  return;
}
      // ==========================================
      // CORS
      // ==========================================

      if (
        req.method === "OPTIONS"
      ) {

        res.writeHead(
          204,
          {

            "Access-Control-Allow-Origin":
              "*",

            "Access-Control-Allow-Methods":
              "GET, POST, OPTIONS",

            "Access-Control-Allow-Headers":
              "Content-Type"

          }
        );

        res.end();

        return;

      }


      // ==========================================
      // LOGIN PAGE
      // ==========================================

      if (
        req.method === "GET" &&
        req.url === "/login"
      ) {

        const filePath =
          path.join(
            __dirname,
            "login.html"
          );

        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html; charset=utf-8"
          }
        );

        fs
          .createReadStream(filePath)
          .pipe(res);

        return;

      }


      // ==========================================
      // HOME PAGE
      // ==========================================

      if (
        req.method === "GET" &&
        req.url === "/"
      ) {

        const user =
          getCurrentUser(req);


        if (!user) {

          const loginPath =
            path.join(
              __dirname,
              "login.html"
            );

          res.writeHead(
            200,
            {
              "Content-Type":
                "text/html; charset=utf-8"
            }
          );

          fs
            .createReadStream(loginPath)
            .pipe(res);

          return;

        }


        const filePath =
          path.join(
            __dirname,
            "index.html"
          );


        if (
          !fs.existsSync(filePath)
        ) {

          res.writeHead(
            404,
            {
              "Content-Type":
                "text/plain"
            }
          );

          res.end(
            "index.html not found."
          );

          return;

        }


        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html; charset=utf-8"
          }
        );

        fs
          .createReadStream(filePath)
          .pipe(res);

        return;

      }


      // ==========================================
      // SIGN UP
      // ==========================================

      if (
        req.method === "POST" &&
        req.url === "/api/signup"
      ) {

        try {

          const body =
            await getBody(req);

          const name =
            String(
              body.name || ""
            ).trim();

          const email =
            String(
              body.email || ""
            )
              .trim()
              .toLowerCase();

          const password =
            String(
              body.password || ""
            );


          if (
            !name ||
            !email ||
            !password
          ) {

            sendJSON(
              res,
              400,
              {
                success: false,
                message:
                  "Please fill all fields."
              }
            );

            return;

          }


          if (
            password.length < 6
          ) {

            sendJSON(
              res,
              400,
              {
                success: false,
                message:
                  "Password must contain at least 6 characters."
              }
            );

            return;

          }


          const existingUser =
            db.prepare(`
              SELECT id
              FROM users
              WHERE email = ?
            `).get(email);


          if (existingUser) {

            sendJSON(
              res,
              400,
              {
                success: false,
                message:
                  "An account with this email already exists."
              }
            );

            return;

          }


          const passwordHash =
            await bcrypt.hash(
              password,
              12
            );


          const result =
            db.prepare(`
              INSERT INTO users
              (name, email, password_hash)
              VALUES (?, ?, ?)
            `).run(
              name,
              email,
              passwordHash
            );


          console.log(
            "New user created:",
            email
          );


          sendJSON(
            res,
            200,
            {
              success: true,
              message:
                "Account created successfully.",
              userId:
                result.lastInsertRowid
            }
          );


        } catch (error) {

          console.error(
            "Signup error:",
            error
          );


          sendJSON(
            res,
            500,
            {
              success: false,
              message:
                "Account creation failed."
            }
          );

        }

        return;

      }


      // ==========================================
      // LOGIN
      // ==========================================

      if (
        req.method === "POST" &&
        req.url === "/api/login"
      ) {

        try {

          const body =
            await getBody(req);

          const email =
            String(
              body.email || ""
            )
              .trim()
              .toLowerCase();

          const password =
            String(
              body.password || ""
            );


          const user =
            db.prepare(`
              SELECT *
              FROM users
              WHERE email = ?
            `).get(email);


          if (!user) {

            sendJSON(
              res,
              401,
              {
                success: false,
                message:
                  "Invalid email or password."
              }
            );

            return;

          }


          const passwordCorrect =
            await bcrypt.compare(
              password,
              user.password_hash
            );


          if (!passwordCorrect) {

            sendJSON(
              res,
              401,
              {
                success: false,
                message:
                  "Invalid email or password."
              }
            );

            return;

          }


          const sessionToken =
            createSession(user.id);


          sendJSON(
            res,
            200,
            {
              success: true,
              message:
                "Login successful.",
              user: {
                id: user.id,
                name: user.name,
                email: user.email
              }
            },
            {
              "Set-Cookie":
                `session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`
            }
          );


          console.log(
            "User logged in:",
            email
          );


        } catch (error) {

          console.error(
            "Login error:",
            error
          );


          sendJSON(
            res,
            500,
            {
              success: false,
              message:
                "Login failed."
            }
          );

        }

        return;

      }


      // ==========================================
      // CURRENT USER
      // ==========================================

      if (
        req.method === "GET" &&
        req.url === "/api/me"
      ) {

        const user =
          getCurrentUser(req);


        if (!user) {

          sendJSON(
            res,
            401,
            {
              success: false,
              message:
                "Not logged in."
            }
          );

          return;

        }


        sendJSON(
          res,
          200,
          {
            success: true,
            user
          }
        );

        return;

      }


      // ==========================================
      // LOGOUT
      // ==========================================

      if (
        req.method === "POST" &&
        req.url === "/api/logout"
      ) {

        const cookies =
          parseCookies(req);


        if (
          cookies.session
        ) {

          sessions.delete(
            cookies.session
          );

        }


        sendJSON(
          res,
          200,
          {
            success: true,
            message:
              "Logged out."
          },
          {
            "Set-Cookie":
              "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
          }
        );

        return;

      }


      // ==========================================
      // GENERATE PRESENTATION
      // ==========================================

      if (
        req.method === "POST" &&
        req.url === "/api/generate"
      ) {

        try {

          const user =
            getCurrentUser(req);


          if (!user) {

            sendJSON(
              res,
              401,
              {
                success: false,
                error:
                  "Please login first."
              }
            );

            return;

          }


          const body =
            await getBody(req);


          console.log(
            "Generating presentation for:",
            user.email
          );


          const presentation =
            await generatePresentation(
              body
            );


          sendJSON(
            res,
            200,
            {
              success: true,
              presentation:
                presentation
            }
          );


          console.log(
            "Presentation generated successfully."
          );


        } catch (error) {

          console.error(
            "Generation error:",
            error.message
          );


          sendJSON(
            res,
            500,
            {
              success: false,
              error:
                error.message
            }
          );

        }

        return;

      }


      // ==========================================
      // SAVE / UPDATE PRESENTATION DRAFT
      // ==========================================

      if (
        req.method === "POST" &&
        req.url === "/api/presentations"
      ) {

        try {

          const user =
            getCurrentUser(req);


          if (!user) {

            sendJSON(
              res,
              401,
              {
                success: false,
                message:
                  "Please login first."
              }
            );

            return;

          }


          const body =
            await getBody(req);


          const title =
            String(
              body.title ||
              "Untitled Presentation"
            ).trim();


          /*
            IMPORTANT:
            content can arrive either as an object
            or as an already-stringified JSON string.
          */

          let content;

          if (
            typeof body.content ===
            "string"
          ) {

            content =
              body.content;

          } else {

            content =
              JSON.stringify(
                body.content || {}
              );

          }


          const pptData =
            body.pptData
              ? String(
                  body.pptData
                )
              : null;


          const presentationId =
            Number(
              body.presentationId
            ) || 0;


          // ==========================================
          // UPDATE EXISTING DRAFT
          // ==========================================

          if (presentationId > 0) {

            const existing =
              db.prepare(`
                SELECT id
                FROM presentations
                WHERE id = ?
                AND user_id = ?
              `).get(
                presentationId,
                user.id
              );


            if (!existing) {

              sendJSON(
                res,
                404,
                {
                  success: false,
                  message:
                    "Draft presentation not found."
                }
              );

              return;

            }


            db.prepare(`
              UPDATE presentations

              SET
                title = ?,
                content = ?,
                ppt_data = ?,
                updated_at = CURRENT_TIMESTAMP

              WHERE id = ?
              AND user_id = ?
            `).run(
              title,
              content,
              pptData,
              presentationId,
              user.id
            );


            console.log(
              "Draft updated:",
              presentationId,
              user.email
            );


            sendJSON(
              res,
              200,
              {
                success: true,
                presentationId:
                  presentationId,
                updated: true,
                status: "draft"
              }
            );


            return;

          }


          // ==========================================
          // CREATE NEW DRAFT
          // ==========================================

          const result =
            db.prepare(`
              INSERT INTO presentations
              (
                user_id,
                title,
                content,
                ppt_data,
                updated_at
              )
              VALUES
              (?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(
              user.id,
              title,
              content,
              pptData
            );


          const newId =
            result.lastInsertRowid;


          console.log(
            "New draft saved:",
            newId,
            user.email
          );


          sendJSON(
            res,
            200,
            {
              success: true,
              presentationId:
                newId,
              updated: false,
              status: "draft"
            }
          );


        } catch (error) {

          console.error(
            "Save/update error:",
            error
          );


          sendJSON(
            res,
            500,
            {
              success: false,
              message:
                "Could not save presentation."
            }
          );

        }

        return;

      }


      // ==========================================
      // GET USER PRESENTATIONS
      // ==========================================

      if (
        req.method === "GET" &&
        req.url === "/api/presentations"
      ) {

        try {

          const user =
            getCurrentUser(req);


          if (!user) {

            sendJSON(
              res,
              401,
              {
                success: false,
                message:
                  "Please login first."
              }
            );

            return;

          }


          const presentations =
            db.prepare(`
              SELECT
                id,
                title,
                created_at,
                updated_at
              FROM presentations
              WHERE user_id = ?
              ORDER BY
                COALESCE(
                  updated_at,
                  created_at
                ) DESC
            `).all(user.id);


          sendJSON(
            res,
            200,
            {
              success: true,
              presentations
            }
          );


        } catch (error) {

          console.error(
            "Presentation list error:",
            error
          );


          sendJSON(
            res,
            500,
            {
              success: false,
              message:
                "Could not load presentations."
            }
          );

        }

        return;

      }


      // ==========================================
      // GET ONE PRESENTATION / RESUME DRAFT
      // ==========================================

      if (
        req.method === "GET" &&
        req.url.startsWith(
          "/api/presentations/"
        )
      ) {

        try {

          const user =
            getCurrentUser(req);


          if (!user) {

            sendJSON(
              res,
              401,
              {
                success: false,
                message:
                  "Please login first."
              }
            );

            return;

          }


          const idText =
            req.url
              .split("?")[0]
              .split("/")
              .pop();


          const presentationId =
            Number(idText);


          if (
            !Number.isInteger(
              presentationId
            ) ||
            presentationId <= 0
          ) {

            sendJSON(
              res,
              400,
              {
                success: false,
                message:
                  "Invalid presentation ID."
              }
            );

            return;

          }


          const presentation =
            db.prepare(`
              SELECT
                id,
                title,
                content,
                ppt_data,
                created_at,
                updated_at
              FROM presentations
              WHERE id = ?
              AND user_id = ?
            `).get(
              presentationId,
              user.id
            );


          if (!presentation) {

            sendJSON(
              res,
              404,
              {
                success: false,
                message:
                  "Presentation not found."
              }
            );

            return;

          }


          let parsedContent =
            null;


          try {

            /*
              New drafts store normal JSON.

              Older presentations may have been
              saved as JSON.stringify(string),
              so we support both formats.
            */

            parsedContent =
              JSON.parse(
                presentation.content
              );


            if (
              typeof parsedContent ===
              "string"
            ) {

              try {

                parsedContent =
                  JSON.parse(
                    parsedContent
                  );

              } catch {

                // Keep original string.

              }

            }

          } catch {

            parsedContent =
              null;

          }


          sendJSON(
            res,
            200,
            {
              success: true,
              presentation: {
                id:
                  presentation.id,

                title:
                  presentation.title,

                content:
                  parsedContent,

                pptData:
                  presentation.ppt_data,

                created_at:
                  presentation.created_at,

                updated_at:
                  presentation.updated_at,

                status:
                  "draft"
              }
            }
          );


        } catch (error) {

          console.error(
            "Load presentation error:",
            error
          );


          sendJSON(
            res,
            500,
            {
              success: false,
              message:
                "Could not open presentation."
            }
          );

        }

        return;

      }


      // ==========================================
      // HEALTH CHECK
      // ==========================================

      if (
        req.method === "GET" &&
        req.url === "/api/health"
      ) {

        sendJSON(
          res,
          200,
          {
            success: true,
            ai: "Ollama",
            model: MODEL,
            authentication:
              "Enabled",
            database:
              "SQLite",
            message:
              "PreGenerator backend is running."
          }
        );

        return;

      }


      // ==========================================
      // 404
      // ==========================================

      sendJSON(
        res,
        404,
        {
          success: false,
          error:
            "Route not found."
        }
      );

    }
  );


// ==========================================
// START SERVER
// ==========================================

server.listen(
  PORT,
  () => {

    console.log("");

    console.log(
      "======================================"
    );

    console.log(
      "          PreGenerator AI"
    );

    console.log(
      "======================================"
    );

    console.log("");

    console.log(
      `Website: http://localhost:${PORT}`
    );

    console.log("");

    console.log(
      "AI: Ollama + llama3.2:3b"
    );

    console.log(
      "Database: SQLite"
    );

    console.log(
      "Authentication: Enabled"
    );

    console.log(
      "Draft Save: Enabled"
    );

    console.log("");

    console.log(
      "Backend is ready."
    );

    console.log("");

  }
);