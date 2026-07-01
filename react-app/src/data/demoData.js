export const demoIndexData = {
  platoons: [
    {
      id: "1st",
      name: "1st Platoon",
      file: "inventories/demo-1st.json"
    },
    {
      id: "ms",
      name: "MS Platoon",
      file: "inventories/demo-ms.json"
    }
  ]
};

const demoItems = [
  {
    title: "H53576 HIGH MOBILITY ENGINEER EXCAVATOR (HMEE)",
    fields: [
      {
        label: "Image",
        value: ["https://ms-inventories.s3.us-east-1.amazonaws.com/images/hmee.png"]
      },
      {
        label: "Common Name",
        value: "HMEE"
      },
      {
        label: "NSN",
        value: "2420015354061"
      },
      {
        label: "Description",
        value: "Tan JCB-style backhoe used around the motor pool."
      },
      {
        label: "Location",
        value: "Motor pool row. Verify bumper number before closing out."
      },
      {
        label: "OH Qty",
        value: "1"
      },
      {
        label: "Actual",
        value: "1"
      }
    ]
  },
  {
    title: "MED COMBAT LIFESAVER VERSION 2005",
    fields: [
      {
        label: "Image",
        value: ["https://ms-inventories.s3.us-east-1.amazonaws.com/images/CLS-BAG.jpg"]
      },
      {
        label: "Common Name",
        value: "CLS bag"
      },
      {
        label: "NSN",
        value: "6545015323674"
      },
      {
        label: "Description",
        value: "Camo bag filled with medical supplies."
      },
      {
        label: "Location",
        value: "Medic storage area. Confirm quantity with the NCOIC."
      },
      {
        label: "OH Qty",
        value: "1"
      },
      {
        label: "Actual",
        value: "1"
      }
    ]
  },
  {
    title: "N96248 NAVIGATION SET: SATELLITE SIGNALS AN/PSN",
    fields: [
      {
        label: "Image",
        value: ["https://ms-inventories.s3.us-east-1.amazonaws.com/images/dagr.jpg"]
      },
      {
        label: "Common Name",
        value: "DAGR GPS"
      },
      {
        label: "NSN",
        value: "5825015264783"
      },
      {
        label: "Description",
        value: "Handheld GPS device usually stored with radio equipment."
      },
      {
        label: "Location",
        value: "Radio cage, top shelf."
      },
      {
        label: "OH Qty",
        value: "4"
      },
      {
        label: "Actual",
        value: "4"
      }
    ]
  }
];

export const demoInventoriesByFile = {
  "inventories/demo-1st.json": {
    password: "demo",
    items: demoItems
  },
  "inventories/demo-ms.json": {
    password: "demo",
    items: demoItems
  },
  "inventories/ms.json": {
    password: "demo",
    items: demoItems
  }
};
