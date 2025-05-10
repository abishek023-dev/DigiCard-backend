import express from "express";
import { Pool } from "pg";
import dotenv from "dotenv";
import cors from "cors";
import axios from 'axios';
import twilio from "twilio";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});


const twilioClient = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const app = express();
app.use(express.json());
app.use(cors());

// PostgreSQL client setup
const client = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create tables if not already created
async function createTables() {
  const createUsersTable = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    password TEXT NOT NULL,
    image TEXT,
    phone VARCHAR(15),
    role VARCHAR(50) DEFAULT 'Student',
    status VARCHAR(20) DEFAULT 'in',
    offences INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

  const createRequestsTable = `
    CREATE TABLE IF NOT EXISTS requests (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      type VARCHAR(20) NOT NULL,
      image TEXT,
      purpose TEXT NOT NULL,
      role VARCHAR(20) DEFAULT 'Student',
      status VARCHAR(20) DEFAULT 'Pending',
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    await client.query(createUsersTable);
    await client.query(createRequestsTable);
    console.log("Tables created or already exist.");
  } catch (err) {
    console.error("Error creating tables:", err);
  }
}

// Function to approve or reject a request
app.patch("/api/requests/:username/:action", async (req, res) => {
  const { username, action } = req.params;
  if (!["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }

  try {
    const requestRes = await pool.query(
      `SELECT * FROM requests WHERE username = $1 AND status = 'Pending' ORDER BY requested_at DESC LIMIT 1`,
      [username]
    );

    if (requestRes.rows.length === 0) {
      return res.status(404).json({ error: "No pending request found" });
    }

    const request = requestRes.rows[0];

    await pool.query(`UPDATE requests SET status = $1 WHERE id = $2`, [
      action==="approve"?"Approved":"Rejected",
      request.id,
    ]);

    if (action === "approve") {
      const userRes = await pool.query(
        `SELECT status FROM users WHERE username = $1`,
        [username]
      );

      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      const currentStatus = userRes.rows[0].status.toLowerCase();
      const newStatus = currentStatus === "in" ? "out" : "in";

      await pool.query(`UPDATE users SET status = $1 WHERE username = $2`, [
        newStatus,
        username,
      ]);
    }

    res.status(200).json({ message: `Request ${action}d successfully` });
  } catch (error) {
    console.error("Error processing request:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Route to get pending requests
app.get("/api/requests/pending", async (req, res) => {
  try {
    const result = await client.query(
      `SELECT * FROM requests WHERE status = 'Pending' AND type in ('in', 'out') ORDER BY requested_at DESC`
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching requests:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Route to create a user
app.post("/api/users", async (req, res) => {
  const { username, password, role, status, name, phone, image } = req.body;
  try {
    const result = await client.query(
      `INSERT INTO users (username, password, role, status, name, phone, image) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [username, password, role, status, name, phone, image]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Route to delete a user by username
app.delete("/api/users/:username", async (req, res) => {
  const { username } = req.params;

  try {
    // First delete all requests associated with this user (optional, for cleanup)
    await pool.query(`DELETE FROM requests WHERE username = $1`, [username]);

    // Then delete the user
    const result = await pool.query(`DELETE FROM users WHERE username = $1 RETURNING *`, [username]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json({ message: "User deleted successfully", user: result.rows[0] });
  } catch (err) {
    console.error("Error deleting user:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// Route to check if a user has any pending requests
app.get("/api/requests/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const result = await client.query(
      `SELECT * FROM requests WHERE username = $1 AND status = 'Pending'`,
      [username]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching pending requests:", err);
    res.status(500).send("Server error");
  }
});

// Route to submit a new request
app.post("/api/requests", async (req, res) => {
  const { username, role, requestType, purpose, image } = req.body;
  try {
    const existing = await client.query(
      `SELECT * FROM requests WHERE username = $1 AND status = 'Pending' AND type IN ('in', 'out')`,
      [username]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Request already pending" });
    }

    await client.query(
      `INSERT INTO requests (username, role, type, purpose, image, status, requested_at) 
       VALUES ($1, $2, $3, $4, $5, 'Pending', NOW())`,
      [username, role, requestType, purpose, image]
    );
    res.status(201).json({ message: "Request submitted successfully" });
  } catch (err) {
    console.error("Error inserting request:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Route to get all users
app.get("/api/users", async (req, res) => {
  try {
    const result = await client.query(`SELECT * FROM users`);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// Route to get user by username
app.get("/api/users/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const result = await client.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ error: "User not found" });
    }
  } catch (err) {
    console.error("Error fetching user:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/alert", async (req, res) => {
  try {
    // Fetch students who are 'out' and visitors who are 'in'
    const studentsOut = await pool.query(
      `SELECT id, phone FROM users WHERE role = 'student' AND status = 'out'`
    );
    const visitorsIn = await pool.query(
      `SELECT phone FROM users WHERE role = 'visitor' AND status = 'in'`
    );

    // Increment offences for students who are out
    const studentIds = studentsOut.rows.map(student => student.id);
    if (studentIds.length > 0) {
      await pool.query(
        `UPDATE users SET offences = offences + 1 WHERE id = ANY($1::int[])`,
        [studentIds]
      );
    }

    // Combine phone numbers of students and visitors
    const recipients = [...studentsOut.rows, ...visitorsIn.rows]
      .map(row => row.phone)
      .filter(Boolean);

    if (recipients.length === 0) {
      return res.status(200).json({ message: "No users to notify." });
    }

    // Message to send
    const message =
      "Greetings from IIIT Bhubaneswar. This is to inform you that your ward is currently outside the campus or, if you are a visitor, you are presently inside the campus. Kindly ensure that students return to campus promptly and visitors exit the premises at the earliest. We appreciate your cooperation in maintaining campus safety and discipline.";

    // Send SMS using Twilio
    const promises = recipients.map(phone =>
      twilioClient.messages.create({
        body: message,
        to: phone,
        from: process.env.TWILIO_PHONE_NUMBER,
      })
    );

    // Wait for all messages to be sent
    await Promise.all(promises);

    res.status(200).json({ message: "Alert sent and offences updated successfully!" });
  } catch (error) {
    console.error("Error sending alerts:", error);
    res.status(500).json({ error: "Failed to send alerts" });
  }
});

app.get("/api/warden/requests/pending", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM requests WHERE type = 'OOHostel' AND status = 'Pending' ORDER BY requested_at DESC`
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching OOHostel requests:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Warden route to approve or reject 'OOHostel' requests
app.patch("/api/warden/requests/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  if (!["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }

  try {
    const requestRes = await pool.query(
      `SELECT * FROM requests WHERE id = $1 AND type = 'OOHostel' AND status = 'Pending'`,
      [id]
    );

    if (requestRes.rows.length === 0) {
      return res.status(404).json({ error: "No pending OOHostel request found" });
    }

    const request = requestRes.rows[0];

    await pool.query(`UPDATE requests SET status = $1 WHERE id = $2`, [
      action==="approve"?"Approved":"Rejected",
      id,
    ]);

    if (action === "approve") {
      const userRes = await pool.query(
        `SELECT status FROM users WHERE username = $1`,
        [request.username]
      );

      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      const newStatus = "home";

      await pool.query(`UPDATE users SET status = $1 WHERE username = $2`, [
        newStatus,
        request.username,
      ]);
    }

    res.status(200).json({ message: `OOHostel request ${action}d successfully` });
  } catch (error) {
    console.error("Error processing OOHostel request:", error);
    res.status(500).json({ error: "Server error" });
  }
});


app.get("/api/usersearch", async (req, res) => {
  const { query } = req.query;
  try {
    const result = await client.query(
      `SELECT * FROM users 
       WHERE username ILIKE $1 
       OR role ILIKE $1 
       OR status ILIKE $1 
       OR name ILIKE $1 
       OR phone ILIKE $1`,
      [`%${query}%`]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error searching users:", err);
    res.status(500).json({ error: "Failed to search users." });
  }
});

app.get("/api/userstats", async (req, res) => {
  try {
    // Count users by role
    const roleStats = await pool.query(
      `SELECT role, COUNT(*) as count FROM users GROUP BY role`
    );
    
    // Count users by status
    const statusStats = await pool.query(
      `SELECT status, COUNT(*) as count FROM users GROUP BY status`
    );
    
    // Count users in/out/home
    const inOutStats = await pool.query(
      `SELECT 
        SUM(CASE WHEN status = 'in' THEN 1 ELSE 0 END) as in_count,
        SUM(CASE WHEN status = 'out' THEN 1 ELSE 0 END) as out_count,
        SUM(CASE WHEN status = 'home' THEN 1 ELSE 0 END) as home_count
      FROM users`
    );
    
    res.json({
      byRole: roleStats.rows,
      byStatus: statusStats.rows,
      inCampus: inOutStats.rows[0]
    });
  } catch (err) {
    console.error("Error fetching user stats:", err);
    res.status(500).json({ error: "Failed to fetch user statistics" });
  }
});

app.get("/api/requeststats", async (req, res) => {
  try {
    // Daily request stats for last 30 days
    const dailyStats = await pool.query(
      `SELECT 
        DATE(requested_at) as date, 
        COUNT(*) as total_requests,
        SUM(CASE WHEN status = 'Approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'Rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as pending
      FROM requests 
      WHERE requested_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(requested_at) 
      ORDER BY DATE(requested_at) DESC`
    );
    
    // Count requests by type
    const typeStats = await pool.query(
      `SELECT type, COUNT(*) as count FROM requests GROUP BY type`
    );
    
    res.json({
      daily: dailyStats.rows,
      byType: typeStats.rows
    });
  } catch (err) {
    console.error("Error fetching request stats:", err);
    res.status(500).json({ error: "Failed to fetch request statistics" });
  }
});


app.get("/api/students/offenders", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM users 
       WHERE role = 'student' AND offences > 1 
       ORDER BY offences DESC`
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching offenders:", err);
    res.status(500).json({ error: "Failed to fetch students with offences" });
  }
});


app.patch("/api/students/:username/clear-offences", async (req, res) => {
  const { username } = req.params;
  try {
    const result = await pool.query(
      `UPDATE users 
       SET offences = 0 
       WHERE username = $1 
       RETURNING *`,
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Student not found" });
    }
    
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Error clearing offences:", err);
    res.status(500).json({ error: "Failed to clear offences" });
  }
});

// DELETE route to remove a user by username
app.delete("/api/users/:username", async (req, res) => {
  const { username } = req.params;

  try {
    // First delete all requests associated with this user (optional, for cleanup)
    await pool.query(`DELETE FROM requests WHERE username = $1`, [username]);

    // Then delete the user
    const result = await pool.query(
      `DELETE FROM users WHERE username = $1 RETURNING *`,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json({ 
      message: "User deleted successfully", 
      user: result.rows[0] 
    });
  } catch (err) {
    console.error("Error deleting user:", err);
    res.status(500).json({ error: "Server error during user deletion" });
  }
});

const PORT = process.env.PORT || 3000;
client.connect().then(() => {
  createTables();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
