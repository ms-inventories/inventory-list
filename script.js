    const items = [
      {
        title: "MED COMBAT LIFESAVER VERSION 2005",
        fields: [
          { label: "Image", value: "assets/CLS-BAG.jpg" },
          { label: "NSN", value: "6545015323674" },
          { label: "Description", value: "Camo bag filled with med supplies." },
          { label: "Location", value: "1 located in the office cage, rest are in the medics office in a pile with the rest of the companies" },
          { label: "OH Qty", value: "1" },
          { label: "Actual", value: "1" }
        ]
      },
      {
        title: "63053N CUTTING MACHINE OXYGEN, MET CTG PORT 42",
        fields: [
          { label: "Image", value: "assets/torch.jpg" },
          { label: "NSN", value: "343301C123998" },
          { label: "Description", value: "Portable cutting torches" },
          { label: "Location", value: "Located in platoon office cage on left side" },
          { label: "OH Qty", value: "1" },
          { label: "Actual", value: "1" }
        ]
      },
      {
        title: "A90594 ARMAMENT SUBSYS: M153",
        fields: [
          { label: "Image", value: "https://placehold.co/200x300" },
          { label: "NSN", value: "1090251601292" },
          { label: "SN", value: "[4CAB5002513, 4CAB5A1182]" },
          { label: "Description", value: "Mounted to the trucks. Part of the CROW gunning system. Allows mounting a machine gun to the roof with computer control." },
          { label: "Location", value: "On trucks" },
          { label: "OH Qty", value: "2" },
          { label: "Actual", value: "2" }
        ]
      },
      {
        title: "B67766 BINOCULAR MODULAR CONSTRUCTION MIL SCAL M22",
        fields: [
          { label: "Image", value: "assets/big-bino.jpg" },
          { label: "NSN", value: "1240013611318" },
          { label: "Description", value: "Large binoculars like the ones used for hunting." },
          { label: "Location", value: "Found in the platoon cage (right side)" },
          { label: "OH Qty", value: "3" },
          { label: "Actual", value: "3" }
        ]
      },
      {
        title: "B67839 BINOCULAR M24",
        fields: [
          { label: "Image", value: "assets/small-images.jpg" },
          { label: "NSN", value: "1240014993547" },
          { label: "Description", value: "Smaller binoculars with a case." },
          { label: "Location", value: "Office cage" },
          { label: "OH Qty", value: "8" },
          { label: "Actual", value: "8" }
        ]
      },
      {
        title: "CO5036 COMPUTER SYSTEM DIGITAL",
        fields: [
          { label: "Image", value: "https://placehold.co/300X300" },
          { label: "NSN", value: "7010016269244" },
          { label: "SN", value: "B2UYK128DUP00017" },
          { label: "Description", value: "A computer that is mounted in a truck" },
          { label: "Location", value: "Could not find – Perhaps in a truck that’s not on site" },
          { label: "OH Qty", value: "1" },
          { label: "Actual", value: "1" }
        ]
      },
      {
        title: "D41659 DRIVERS ENHANCERS: AN/VAS-5",
        fields: [
          { label: "Image", value: "assets/dve.jpg" },
          { label: "Description", value: "Sensors that mount on the front of a truck." },
          { label: "Location", value: "Pelican cases in the Stable Cages (Top Shelf all the way in). Sensors currently mounted on trucks." },
          { label: "NSN (1)", value: "5855015049801 – OH Qty: 5" },
          { label: "NSN (2)", value: "5855015052209 – OH Qty: 4" },
          { label: "Actual", value: "? (unknown)" }
        ]
      },
      {
        title: "F87237 FIRING ATTACHMENT BLANK AMMUNITION: M19",
        fields: [
          { label: "Image", value: "assets/50-cal.jpg" },
          { label: "NSN", value: "1005010917510" },
          { label: "SN", value: "[1023044063, 1023044107]" },
          { label: "Description", value: "Found in the MS Platoon Office Cage. Still in the silver wrappers (top shelf right side)." },
          { label: "OH Qty", value: "2" },
          { label: "Actual", value: "2" }
        ]
      },
      {
        title: "H05004 HYDRAULIC ELETRIC PNEUMATIC PETROLEUM O (TOOL KIT, PIONEER, EN)",
        fields: [
          { label: "Image", value: "assets/hippo.jpg" },
          { label: "NSN", value: "5180015556134" },
          { label: "SN", value: "0313" },
          { label: "Description", value: "A giant green generator for all the HIPAA (HIPPO) tools. Located in the conex closest to the stables." },
          { label: "OH Qty", value: "1" },
          { label: "Actual", value: "1" }
        ]
      },
      {
        title: "H53576 HIGH MOBILITY ENGINEER EXCAVATOR (HMEE)",
        fields: [
          { label: "Image", value: "assets/hmee.png" },
          { label: "NSN", value: "2420015354061" },
          { label: "SN", value: "GE0HMEE1C91063187/UC09GK" },
          { label: "Description", value: "JCB-made backhoe painted tan located in the motorpool" },
          { label: "OH Qty", value: "1" },
          { label: "Actual", value: "1" }
        ]
      },
      {
        title: "L77215 LOADSKDSTRTYPIII",
        fields: [
          { label: "Image", value: "assets/skidsteer.png" },
          { label: "NSN", value: "3805015524487" },
          { label: "SN", value: "NCM459289/UA07G0" },
          { label: "Description", value: "Bobcat/Skidsteer in the garage usually with forks attached" },
          { label: "OH Qty", value: "1" },
          { label: "Actual", value: "1" }
        ]
      },
      {
        title: "N96248 NAVIGATION SET: SATELLITE SIGNALS AN/PSN (NA SE SA AN/PSN-13(A))",
        fields: [
          { label: "Image", value: "assets/dagr.jpg" },
          { label: "NSN", value: "5825015264783" },
          { label: "SN", value: "[249473, 249475, 249477, 249482]" },
          { label: "Description", value: "DAGR GPS found in the radio cages (top right of cage furthest in the room)" },
          { label: "OH Qty", value: "4" },
          { label: "Actual", value: "4" }
        ]
      },
      {
        title: "R31061 RADIAC SET: AN/UDR-13",
        fields: [
          { label: "Image", value: "assets/radiac.jpg" },
          { label: "NSN", value: "6665014071237" },
          { label: "SN", value: "16368A" },
          { label: "Description", value: "Small green personally carried radiation detector located in the CBRN Room on the computer desk. Comes in a small green pouch." },
          { label: "OH Qty", value: "1" },
          { label: "Actual", value: "1" }
        ]
      },
      {
        title: "R55336 RADIO SET (AN/PRC-148(v)2)",
        fields: [
          { label: "Image", value: "assets/radio.jpg" },
          { label: "NSN", value: "5820014601605" },
          { label: "SN", value: "[4101195-501-58237, 4101195-501-58428, 4101195-501-58494, 4101195-501-58522]" },
          { label: "Description", value: "Portable radio set" },
          { label: "Location", value: "In the radio cage in the back" },
          { label: "OH Qty", value: "4" },
          { label: "Actual", value: "4" }
        ]
      },
      {
        title: "R68044 RADIO SET: AN/VRC-90F(C)",
        fields: [
          { label: "Image", value: "assets/radioset.png" },
          { label: "NSN", value: "N/A" },
          { label: "Description", value: "A set of radio parts that assemble into a vehicle mounted radio. In various trucks and radio cages (mixed with company radio parts)." },
          { label: "Location", value: "Radio cages & various trucks" },
          { label: "OH Qty", value: "(Not specified)" },
          { label: "Actual", value: "(Not specified)" }
        ]
      },
      {
        title: "R68146 RADIO SET: AN/VRC-91F(C)21663475RNG02",
        fields: [
          { label: "Image", value: "assets/radioset.png" },
          { label: "NSN", value: "N/A" },
          { label: "Description", value: "A set of radio parts that assemble into a vehicle mounted radio. Mixed with all radio parts for the company." },
          { label: "Location", value: "In HMMWVs/trucks & radio cages" },
          { label: "OH Qty", value: "(Not specified)" },
          { label: "Actual", value: "(Not specified)" }
        ]
      },
      {
        title: "T05106 TRAILER, FLAT BED",
        fields: [
          { label: "Image", value: "https://placehold.co/200x300" },
          { label: "NSN", value: "2330016207184" },
          { label: "SN", value: "LEUTII0056" },
          { label: "Description", value: "Trailer is not in the motor pool; reportedly at Fort Indiantown Gap getting worked on" },
          { label: "OH Qty", value: "1" },
          { label: "Actual", value: "1" }
        ]
      },
      {
        title: "T07679 TRUCK UTILITY: HEAVY VARIANT HMMWV 4X4 1",
        fields: [
          { label: "Image", value: "https://placehold.co/200x300" },
          { label: "NSN", value: "2320013469317" },
          { label: "SN", value: "600681/NZ0BZ9" },
          { label: "Description", value: "This HMMWV can be found in the motorpool" },
          { label: "OH Qty", value: "1" },
          { label: "Actual", value: "1" }
        ]
      },
      {
        title: "T65342 TRUCK DUMP: 10T WO/WINCH",
        fields: [
          { label: "Image", value: "https://placehold.co/200x300" },
          { label: "NSN", value: "2320015527787" },
          { label: "SN", value: "[DX-120388EGFV/NP25QS, DX-12039OEGFV/NP25QU]" },
          { label: "Description", value: "In the motorpool. NP25QS is not here. So 1 physically present." },
          { label: "OH Qty", value: "2" },
          { label: "Actual", value: "1" }
        ]
      },
      {
        title: "T71687 TENT: EXTENDABLE MODULAR 48LX20WUTILITY",
        fields: [
          { label: "Image", value: "https://placehold.co/200x300" },
          { label: "NSN", value: "8340011852615" },
          { label: "SN", value: "1011019723" },
          { label: "Description", value: "In the stables cage: giant black bags on the inner wall (poles), large heavy canvas bag at the far end (tent). SN is on a flap, requires pulling most of the tent out to read." },
          { label: "OH Qty", value: "1" },
          { label: "Actual", value: "1" }
        ]
      },
      {
        title: "T88983 TRUCK TRACTOR WO/WINCH",
        fields: [
          { label: "Image", value: "https://placehold.co/200x300" },
          { label: "NSN", value: "2320015527759" },
          { label: "SN", value: "[10TANHFF2ES767579/NL2ML7, 10TANHFF3ES769549/NL2ML6, 10TANHFF5ES767592/NL2MLH]" },
          { label: "Description", value: "LPAC trucks (5th Wheel) that can pull semi-trailers. 2 in motorpool; NL2ML7 is not here (possibly at Gap or Johnstown)." },
          { label: "OH Qty", value: "3" },
          { label: "Actual", value: "2" }
        ]
      },
      {
        title: "T93761 TRAILER: PALLETIZED LOADING 8X20",
        fields: [
          { label: "Image", value: "https://placehold.co/200x300" },
          { label: "NSN", value: "2330013035197" },
          { label: "SN", value: "[088136/NW145Y, 10TMP223081099324/NW1D72]" },
          { label: "Description", value: "8x20 Palletized Loading Trailer" },
          { label: "OH Qty", value: "2" },
          { label: "Actual", value: "2" }
        ]
      },
      {
        title: "T95555 TRAILER CARGO: MTV W/DROPSIDES M1095",
        fields: [
          { label: "Image", value: "https://placehold.co/200x300" },
          { label: "NSN", value: "2330014491776" },
          { label: "SN", value: "[10TDC1523ES769849/PB0QUH, 10TDC1527ES769837/PB0QU2]" },
          { label: "Description", value: "Trailers that have MTV Tarps. Found in Motorpool" },
          { label: "OH Qty", value: "2" },
          { label: "Actual", value: "2" }
        ]
      },
      {
        title: "T95992 LIGHT TACTICAL TRAILER: 3/4 TON (TRL CGO HI MOB 3/4T)",
        fields: [
          { label: "Image", value: "https://placehold.co/200x300" },
          { label: "NSN", value: "2330013875443" },
          { label: "SN", value: "01671/PC099M" },
          { label: "Description", value: "HMMWV trailer found in motorpool" },
          { label: "OH Qty", value: "1" },
          { label: "Actual", value: "(Not specified)" }
        ]
      },
      {
        title: "V05008 TAMPER, VIBRATING TYPE, INTERNAL COMBUST",
        fields: [
          { label: "Image", value: "assets/tamper.jpg" },
          { label: "NSN", value: "3895016100184" },
          { label: "SN", value: "[10543382, 10553384]" },
          { label: "Description", value: "Large walk-behind plate tamper. One is still in the box. Located in the conex closest to the stables." },
          { label: "OH Qty", value: "2" },
          { label: "Actual", value: "2" }
        ]
      },
      {
        title: "XA2001 TRAINING AIDS AND DEVICES (COMPUTER SPECIAL PURPOSE)",
        fields: [
          { label: "Image", value: "assets/training.jpg" },
          { label: "NSN", value: "6920251616274" },
          { label: "Description", value: "Large black pelican case with keyboard and foam to protect the CROW training equipment" },
          { label: "Location", value: "In the cage top shelf on outside wall" },
          { label: "OH Qty", value: "1" },
          { label: "Actual", value: "1" }
        ]
      }
    ];
 const value = "msplatoon";

    /**
     * Checks the password typed by the user.
     * If correct, hides the prompt and shows the content.
     */
    function checkPassword() {
      const userInput = document.getElementById("passwordInput").value;
      if (userInput === value) {
        document.getElementById("passwordPrompt").classList.add("hidden");
        document.getElementById("mainContent").classList.remove("hidden");
        buildItems();
      } else {
        alert("Incorrect password!");
      }
    }

    /**
     * Dynamically builds the items list as tables.
     */
    function buildItems() {
      const container = document.getElementById("itemsContainer");
      
      items.forEach(item => {
        // Create a "card" for each item
        const itemCard = document.createElement("div");
        itemCard.className = "border border-gray-700 rounded p-4";

        // Title
        const titleEl = document.createElement("h2");
        titleEl.textContent = item.title;
        titleEl.className = "text-xl font-bold mb-3";
        itemCard.appendChild(titleEl);

        // Table
        const tableEl = document.createElement("table");
        tableEl.className = "table-auto w-full border border-gray-700";

        item.fields.forEach(field => {
          const row = document.createElement("tr");
          row.className = "border border-gray-700";

          const labelCell = document.createElement("td");
          labelCell.className = "p-2 font-semibold w-1/4 border border-gray-700";
          labelCell.textContent = field.label;

          const valueCell = document.createElement("td");
          valueCell.className = "p-2 border border-gray-700";

          if (field.label.toLowerCase() === "image") {
            if (Array.isArray(field.value)) {
              field.value.forEach((imgSrc) => {
                const img = document.createElement("img");
                img.src = imgSrc;
                img.alt = item.title;
                img.className = "max-h-48 inline-block mr-2 mb-2";
                valueCell.appendChild(img);
              });
            } else {
              const img = document.createElement("img");
              img.src = field.value;
              img.alt = item.title;
              img.className = "max-h-48";
              valueCell.appendChild(img);
            }
          } else {
            valueCell.textContent = field.value;
          }

          row.appendChild(labelCell);
          row.appendChild(valueCell);
          tableEl.appendChild(row);
        });

        itemCard.appendChild(tableEl);
        container.appendChild(itemCard);
      });
    }
