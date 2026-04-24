import streamlit as st
import pandas as pd
import numpy as np
from datetime import date

st.title("Bryce Valley Hardware - Smart Ordering System")
st.write("Upload your RockSolid CSV exports below. The system automatically reserves your Hillman budget, removes outliers, and generates a clean Do It Best upload file.")

# --- 1. SETTINGS & ALLOCATIONS ---
st.subheader("Settings & Allocations")
col1, col2 = st.columns(2)
with col1:
    total_weekly_budget = st.number_input("Total Available Weekly Budget ($):", min_value=0.0, value=3229.0, step=100.0)
with col2:
    hillman_monthly_budget = st.number_input("Hillman Monthly Rep Budget ($):", min_value=0.0, value=800.0, step=100.0)

# --- OUTLIER PROTECTION ---
st.subheader("Outlier & Bulk-Buy Protection")
col3, col4 = st.columns(2)
with col3:
    qty_cap = st.number_input("Max Qty Counted Per Receipt:", min_value=1, value=5, help="Caps bulk buys. If someone buys 12, it only counts as 5 for velocity math.")
with col4:
    min_receipts = st.number_input("Min Historical Receipts Required:", min_value=1, value=1, help="Set to 2 to ignore items that only sold on a single ticket last year.")

# The Exclusion Box
excluded_skus_input = st.text_input("SKUs to Exclude from Do It Best Order (comma-separated):", value="261947", placeholder="e.g., 261947, 123456")
excluded_list = [sku.strip() for sku in excluded_skus_input.split(',')] if excluded_skus_input else []

# Calculate the true DIB budget
weekly_hillman_deduction = hillman_monthly_budget / 4
dib_weekly_budget = total_weekly_budget - weekly_hillman_deduction

st.info(f"**Calculated Do It Best Budget:** ${total_weekly_budget:.2f} (Total) - ${weekly_hillman_deduction:.2f} (Weekly Hillman Reserve) = **${dib_weekly_budget:.2f}**")

# --- 2. FILE UPLOADERS ---
st.subheader("Data Upload")
inv_file = st.file_uploader("1. Upload Inventory CSV (Current QOH & Costs)", type=['csv'])
sales_60_file = st.file_uploader("2. Upload Last 60 Days Sales CSV", type=['csv'])
sales_30_file = st.file_uploader("3. Upload Last Year 30 Days Sales CSV (Seasonal)", type=['csv'])

# --- 3. CUSTOM DATA CLEANER ---
def clean_inventory_row(row):
    """Fixes the RockSolid shifted column issue and extracts the proper DIB SKU."""
    prod_code = str(row.get('Product Code', '')).strip()
    sku = str(row.get('SKU', '')).strip()
    qoh = row.get('QA', 0)
    cost = row.get('Average Cost', '0')
    vendor = str(row.get('Primary Vendor', '')).strip()
    
    sec_vendor = str(row['Secondary Vendor']).strip() if 'Secondary Vendor' in row.index else ''
    desc = str(row.get('Description', '')).strip()
    
    if pd.notna(row.get('Product Code')) and '$' in str(row.get('Product Code')):
        vendor = "UNKNOWN" 
        sku = str(row.get('Primary Vendor', '')).strip()      
        desc = str(row.get('SKU', '')).strip()                
        prod_code = str(row.get('Description', '')).strip()   
        qoh = row.get('standard price', 0)                    
        cost = row.get('QA', '0')                             
        sec_vendor = ""                                       
        
    cost_str = str(cost).replace('$', '').replace(',', '').strip()
    cost_float = pd.to_numeric(cost_str, errors='coerce') 
    
    if pd.isna(cost_float):
        cost_float = 0.0
        
    return pd.Series([prod_code, sku, desc, vendor, sec_vendor, pd.to_numeric(qoh, errors='coerce'), cost_float])

# --- 4. CORE PROCESSING ---
if inv_file and sales_60_file and sales_30_file:
    try:
        st.write("Processing Data...")
        
        df_inv_raw = pd.read_csv(inv_file, skiprows=8)
        df_60_raw = pd.read_csv(sales_60_file, skiprows=8)
        df_30_raw = pd.read_csv(sales_30_file, skiprows=8)
        
        df_inv_raw.columns = df_inv_raw.columns.str.strip()
        df_60_raw.columns = df_60_raw.columns.str.strip()
        df_30_raw.columns = df_30_raw.columns.str.strip()

        df_inv = df_inv_raw.apply(clean_inventory_row, axis=1)
        df_inv.columns = ['Product Code', 'SKU', 'Description', 'Vendor', 'Secondary_Vendor', 'Current_QOH', 'Unit_Cost']
        
        # Format Qty column
        df_60_raw['Qty'] = pd.to_numeric(df_60_raw['Qty'].astype(str).str.replace(',', ''), errors='coerce').fillna(0)
        df_30_raw['Qty'] = pd.to_numeric(df_30_raw['Qty'].astype(str).str.replace(',', ''), errors='coerce').fillna(0)
        
        # --- APPLY OUTLIER CAPS BEFORE GROUPING ---
        df_60_raw['Qty'] = df_60_raw['Qty'].clip(upper=qty_cap)
        df_30_raw['Qty'] = df_30_raw['Qty'].clip(upper=qty_cap)
        
        # Process 60 Day Sales
        df_60 = df_60_raw.groupby('Product Code')['Qty'].sum().reset_index()
        df_60.rename(columns={'Qty': 'Qty_Sold_60_Days'}, inplace=True)
        
        # Process 30 Day Historical Sales & Ticket Counts
        df_30 = df_30_raw.groupby('Product Code').agg(
            Qty_Sold_Last_Year_30_Days=('Qty', 'sum'),
            Ticket_Count=('Qty', 'count') # Counts how many receipts this item was on
        ).reset_index()
        
        # Apply the Minimum Receipt Rule
        df_30.loc[df_30['Ticket_Count'] < min_receipts, 'Qty_Sold_Last_Year_30_Days'] = 0
        df_30.drop(columns=['Ticket_Count'], inplace=True)
        
        # Merge everything
        df_master = pd.merge(df_inv, df_60, on='Product Code', how='left')
        df_master = pd.merge(df_master, df_30, on='Product Code', how='left')
        
        df_master['Qty_Sold_60_Days'] = df_master['Qty_Sold_60_Days'].fillna(0)
        df_master['Qty_Sold_Last_Year_30_Days'] = df_master['Qty_Sold_Last_Year_30_Days'].fillna(0)
        df_master['Current_QOH'] = df_master['Current_QOH'].fillna(0)
        
        df_master.loc[df_master['Product Code'] == 'H', 'Description'] = 'Misc hardware'
        df_master.loc[df_master['Product Code'] == 'H', 'Vendor'] = 'Hillman' 

        df_master['Max_Receipt_Qty'] = 3

        # --- 5. ISOLATE AND REMOVE HILLMAN INVENTORY ---
        is_hillman = (
            df_master['Vendor'].str.lower().str.contains('hillman', na=False) | 
            df_master['Secondary_Vendor'].str.lower().str.contains('hillman', na=False) |
            df_master['Description'].str.lower().str.contains('misc hardware', na=False)
        )
        df_normal = df_master[~is_hillman].copy()

        # --- 6. THE MATH FUNCTION ---
        def calculate_optimal_order(df_subset, budget_limit, exclusions):
            if df_subset.empty: return df_subset
            
            df_subset['SKU'] = df_subset['SKU'].astype(str).str.replace(r'\.0$', '', regex=True).str.strip()
            df_subset = df_subset[df_subset['SKU'].str.match(r'^\d{6}$', na=False)]
            
            if exclusions:
                df_subset = df_subset[~df_subset['SKU'].isin(exclusions)]
            
            if df_subset.empty: return df_subset
                
            df_subset['Current_Velocity'] = df_subset['Qty_Sold_60_Days'] / 8.5
            df_subset['Seasonal_Velocity'] = df_subset['Qty_Sold_Last_Year_30_Days'] / 4.3
            df_subset['Expected_Weekly_Velocity'] = np.maximum(df_subset['Current_Velocity'], df_subset['Seasonal_Velocity'])
            
            df_subset['Target_Stock'] = round((df_subset['Expected_Weekly_Velocity'] * 1) + df_subset['Max_Receipt_Qty'])
            df_subset['Order_Qty'] = df_subset['Target_Stock'] - df_subset['Current_QOH']
            
            df_subset = df_subset[df_subset['Order_Qty'] > 0].copy()
            
            df_subset['Unit_Cost'] = df_subset['Unit_Cost'].replace(0, 0.01)
            
            df_subset['Line_Item_Cost'] = df_subset['Order_Qty'] * df_subset['Unit_Cost']
            df_subset['Priority_Score'] = df_subset['Expected_Weekly_Velocity'] / df_subset['Unit_Cost']
            
            df_subset = df_subset.sort_values(by='Priority_Score', ascending=False)
            df_subset['Cumulative_Cost'] = df_subset['Line_Item_Cost'].cumsum()
            
            return df_subset[df_subset['Cumulative_Cost'] <= budget_limit].copy()

        normal_order = calculate_optimal_order(df_normal, dib_weekly_budget, excluded_list)

        # --- 7. EXPORT FOR DO IT BEST ---
        def generate_dib_csv(df_final):
            df_export = pd.DataFrame()
            df_export['SKU'] = df_final['SKU']
            df_export['OrderQuantity'] = df_final['Order_Qty'].astype(int)
            df_export['MemberRetail'] = ''
            df_export['PromoBulletin'] = ''
            return df_export.to_csv(index=False).encode('utf-8')

        today_str = date.today().strftime("%Y-%m-%d")

        if not normal_order.empty:
            st.success(f"Do It Best Order Total: ${normal_order['Line_Item_Cost'].sum():.2f}")
            st.download_button(
                "Download Do It Best Weekly Order", 
                data=generate_dib_csv(normal_order), 
                file_name=f"DoItBest_Weekly_{today_str}.csv", 
                mime="text/csv"
            )
        else:
            st.warning("No items qualified for the Do It Best Weekly Order.")

    except Exception as e:
        st.error(f"Error processing files: {e}")