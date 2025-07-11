const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();
const port = process.env.PORT || 5000;
const admin = require("firebase-admin");

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

// Middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.nmolcz4.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    //collectons
    const parcelsCollection = client.db("zapShip").collection("parcels");
    const paymentCollection = client.db("zapShip").collection("payments");
    const usersCollection = client.db("zapShip").collection("users");
    const riderApplicationCollection = client
      .db("zapShip")
      .collection("riderApplications");

    //custom middlewares
    const verifyFBToken = async (req, res, next) => {
      // console.log("header in the middleware", req.headers);

      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unathorized access" });
      }

      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unathorized access" });
      }

      // now do the main work here. (verify the token)
      // const decoded = await admin.auth().verifyIdToken(token);
      // instead of this we can write in try catch function to catch errors.

      try {
        const decoded = await admin.auth().verifyIdToken(token);

        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    //verify admin.

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      console.log(email);
      const query = { email };

      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      console.log(email);
      const query = { email };

      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    // Search user by email
    app.get("/users/search", async (req, res) => {
      const { email } = req.query;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const users = await usersCollection
        .find({
          email: { $regex: email, $options: "i" }, // i = case-insensitive
        })
        .limit(10)
        .toArray();

      if (users.length > 0) {
        res.send(users);
      } else {
        res.status(404).send({ message: "No users found" });
      }
    });

    // Update role (admin or remove admin)
    app.patch("/users/role/:email", async (req, res) => {
      const email = req.params.email;
      const { role } = req.body;

      const result = await usersCollection.updateOne(
        { email },
        { $set: { role: role } }
      );

      res.send(result);
    });

    // ✅ Get a user's role by email
    app.get("/users/role", async (req, res) => {
      const email = req.query.email;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(404).send({ message: "User not found" });
      }

      res.send({ role: user.role || "user" }); // default to 'user' if no role set
    });

    // user releted apis
    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        //homework: update the last login info.
        return res
          .status(200)
          .send({ message: "user already exists", inserted: false });
      }

      const user = req.body;

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });
    // GET all parcels
    app.get("/parcels", verifyFBToken, async (req, res) => {
      const userEmail = req.query.email;

      const filter = userEmail ? { created_by_email: userEmail } : {};

      const parcels = await parcelsCollection
        .find(filter)
        .sort({ creation_date: -1 }) // newest first
        .toArray();

      res.send(parcels);
    });

    // get non_collected and paid parcel
    app.get(
      "/parcels/assignable",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { payment_status, delivery_status } = req.query;

        const query = {
          payment_status: payment_status || "paid",
          delivery_status: delivery_status || "not_collected",
        };

        const parcels = await parcelsCollection.find(query).toArray();
        res.send(parcels);
      }
    );

    // ✅ 1. GET riders based on sender_center (district)
    app.get("/riders", verifyFBToken, verifyAdmin, async (req, res) => {
      const district = req.query.district;
      if (!district) {
        return res.status(400).send({ error: "District is required" });
      }

      try {
        const result = await riderApplicationCollection
          .find({
            district: district,
            application_status: { $in: ["approved", "active"] },
            work_status: { $ne: "in-delivery" }, // exclude busy riders
          })
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch riders" });
      }
    });

    // ✅ 2. PATCH assign rider to a parcel
    app.patch("/parcels/assign-rider/:id", async (req, res) => {
      const parcelId = req.params.id;
      const { riderId, riderName, riderEmail } = req.body;

      if (
        !ObjectId.isValid(parcelId) ||
        !ObjectId.isValid(riderId) ||
        !riderName ||
        !riderEmail
      ) {
        return res.status(400).send({ error: "Invalid input data" });
      }

      try {
        const parcelUpdate = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              assigned_rider_id: riderId,
              assigned_rider_name: riderName,
              assigned_rider_email: riderEmail,
              delivery_status: "Rider_assigned",
            },
          }
        );

        res.send(parcelUpdate);
      } catch (error) {
        console.error("Error assigning rider:", error);
        res.status(500).send({ error: "Failed to assign rider" });
      }
    });

    app.get(
      "/parcels/pending-tasks",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const riderEmail = req.query.email;

        if (!riderEmail) {
          return res.status(400).send({ message: "Rider email is required" });
        }

        try {
          const filter = {
            assigned_rider_email: riderEmail,
            delivery_status: { $in: ["Rider_assigned", "in-transit"] },
          };

          const pendingParcels = await parcelsCollection
            .find(filter)
            .sort({ creation_date: -1 })
            .toArray();

          res.send(pendingParcels);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Failed to fetch pending tasks", error });
        }
      }
    );

    app.patch("/parcels/update-status/:id", async (req, res) => {
      const parcelId = req.params.id;
      const { status } = req.body;

      if (!ObjectId.isValid(parcelId)) {
        return res.status(400).send({ message: "Invalid parcel ID" });
      }

      if (!status || typeof status !== "string") {
        return res.status(400).send({ message: "Invalid status value" });
      }

      try {
        const updateFields = {
          delivery_status: status,
        };

        if (status === "delivered") {
          updateFields.delivered_at = new Date();
        } else if (status === "in-transit") {
          updateFields.picked_up_at = new Date();
        }

        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: updateFields }
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update status", error });
      }
    });

    app.get(
      "/parcels/completed",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const riderEmail = req.query.email;

        if (!riderEmail) {
          return res.status(400).send({ message: "Rider email is required" });
        }

        try {
          const filter = {
            assigned_rider_email: riderEmail,
            delivery_status: { $in: ["delivered", "service_center_delivered"] },
          };

          const completedParcels = await parcelsCollection
            .find(filter)
            .sort({ creation_date: -1 })
            .toArray();

          res.send(completedParcels);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Failed to fetch completed deliveries", error });
        }
      }
    );

    // patch method for updating cashout status.
    app.patch(
      "/parcels/:id/cashout",

      async (req, res) => {
        const id = req.params.id;
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              cashout_status: "cashed_out",
              cashed_out_at: new Date(),
            },
          }
        );
        res.send(result);
      }
    );

    app.get(
      "/parcels/rider-earnings",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        try {
          const parcels = await parcelsCollection
            .find({
              assigned_rider_email: email,
              delivery_status: "delivered",
            })
            .toArray();

          let total = 0;
          let cashed_out = 0;
          let pending = 0;

          let today = 0,
            week = 0,
            month = 0,
            year = 0;

          const now = new Date();
          const todayDate = now.toDateString();
          const weekStart = new Date(now.setDate(now.getDate() - now.getDay()));
          const monthStart = new Date(
            new Date().getFullYear(),
            new Date().getMonth(),
            1
          );
          const yearStart = new Date(new Date().getFullYear(), 0, 1);

          for (const parcel of parcels) {
            const fee = parcel.delivery_cost || 0;
            const sameDistrict =
              parcel.sender_region === parcel.receiver_region;
            const earning = sameDistrict ? fee * 0.8 : fee * 0.3;

            total += earning;

            const deliveredAt = new Date(parcel.delivered_at);

            if (parcel.cashout_status === "cashed_out") {
              cashed_out += earning;
            } else {
              pending += earning;
            }

            if (deliveredAt.toDateString() === todayDate) {
              today += earning;
            }

            if (deliveredAt >= weekStart) {
              week += earning;
            }

            if (deliveredAt >= monthStart) {
              month += earning;
            }

            if (deliveredAt >= yearStart) {
              year += earning;
            }
          }

          res.send({
            overall: total.toFixed(0),
            total: total.toFixed(0),
            cashed_out: cashed_out.toFixed(0),
            pending: pending.toFixed(0),
            today: today.toFixed(0),
            week: week.toFixed(0),
            month: month.toFixed(0),
            year: year.toFixed(0),
          });
        } catch (error) {
          console.error("Error calculating rider earnings", error);
          res.status(500).send({ error: "Failed to calculate earnings" });
        }
      }
    );

    // GET: get a specific parcel by ID.
    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;

      const parcel = await parcelsCollection.findOne({ _id: new ObjectId(id) });

      res.send(parcel);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;

      const result = await parcelsCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send(result);
    });

    app.post("/tracking", async (req, res) => {
      const {
        tracking_id,
        parcel_id,
        delevery_status,
        message,
        udpadated_by = "",
      } = req.body;

      const log = {
        tracking_id,
        parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
        delevery_status,
        message,
        time: new Date(),
        udpadated_by,
      };

      const result = await trackingCollection.insertOne(log);
      res.send({ success: true, insertedId: result.insertedId });
    });

    // POST a new parcel
    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      // console.log(req.headers);
      const userEmail = req.query.email;

      console.log("decoded", req.decoded);

      if (req.decoded.email !== userEmail) {
        return res.status(403).send({ message: "forbidden access" });
      }

      const filter = userEmail ? { created_by_email: userEmail } : {};

      const payments = await paymentCollection
        .find(filter)
        .sort({ payment_date: -1 })
        .toArray();

      res.send(payments);
    });

    // another.......
    app.post("/payments", async (req, res) => {
      const {
        parcelId,
        amount,
        transactionId,
        paymentMethod,
        created_by_email,
      } = req.body;
      // console.log(req.body);
      // 1. Update parcel's payment_status
      const updateParcel = await parcelsCollection.updateOne(
        { _id: new ObjectId(parcelId) },
        { $set: { payment_status: "paid", delivery_status: "not_collected" } }
      );
      // 2. Insert into payments collection
      const paymentInfo = {
        parcel_id: new ObjectId(parcelId),
        amount,
        transaction_id: transactionId,
        payment_method: paymentMethod, // ✅ Save it properly
        created_by_email,
        payment_date: new Date(),
        payment_date_string: new Date().toISOString(),
      };
      console.log(paymentInfo);
      // const paymentResult = await client
      //   .db("zap-ship")
      //   .collection("payments")
      //   .insertOne(paymentInfo);
      const paymentResult = await paymentCollection.insertOne(paymentInfo);
      res.send({
        success: true,
        updated: updateParcel.modifiedCount,
        paymentSaved: paymentResult.insertedId,
        insertedId: paymentResult.insertedId,
      });
    });

    //something rleted to payment
    app.post("/create-payment-intent", async (req, res) => {
      const amountInCents = req.body.amountInCents;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents, // Amount in cents
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    //rider releted apis
    app.post("/riderApplications", async (req, res) => {
      const appData = req.body;
      const result = await riderApplicationCollection.insertOne(appData);
      res.send(result);
    });

    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
      const pendingRiders = await riderApplicationCollection
        .find({ application_status: "pending" })
        .sort({ applied_at: -1 })
        .toArray();
      res.send(pendingRiders);
    });

    app.patch(
      "/riders/approve/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const update = req.body;
        const result = await riderApplicationCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: update }
        );
        // 👉 যদি status "active" হয়, তাহলে user role update করো
        if (update.application_status === "active") {
          const riderData = await riderApplicationCollection.findOne({
            _id: new ObjectId(id),
          });
          if (riderData?.email) {
            // ধরো users collection এ email অনুযায়ী role update করতে হবে
            await usersCollection.updateOne(
              { email: riderData.email },
              { $set: { role: "rider" } },
              { upsert: true } // যদি user না থাকে, create করে ফেলে
            );
          }
        }
        res.send(result);
      }
    );

    // Get active riders (or filter by status)
    app.get("/activeRiders", verifyFBToken, verifyAdmin, async (req, res) => {
      const status = req.query.status;
      const query = status ? { application_status: status } : {};

      try {
        const riders = await riderApplicationCollection.find(query).toArray();
        res.send(riders);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch riders." });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// Simple route
app.get("/", (req, res) => {
  res.send("Parcel server is running");
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
